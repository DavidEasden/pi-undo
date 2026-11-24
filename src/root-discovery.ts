import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DirectoryListingCache } from "./directory-listing-cache.ts";
import { checksum, topologyFingerprint } from "./encoding.ts";
import { GitRunError, GitRunner } from "./git-runner.ts";
import type { DiscoveryRoot } from "./model.ts";
import {
	NativeDirectoryScanner,
	type NativeChangeCursor,
	type NativeChangeSet,
	type NativeDirectoryScanPort,
	type NativeRepositoryCandidate,
} from "./native-directory-scan.ts";
import { allCompleted, checkOperation, OperationError, reportOperationProgress } from "./operation-context.ts";

const DIRECTORY_SCAN_CONCURRENCY = 16;
const NATIVE_SCAN_MIN_DIRECTORIES = 64;
const GIT_POINTER_MAX_BYTES = 4096;

interface RepositoryInfo {
	readonly absoluteRoot: string;
	readonly commonGitDir: string;
	readonly sourceIdentity: string;
	readonly treeId: string | null;
}

type RepositoryInspection =
	| { readonly kind: "active"; readonly repository: RepositoryInfo }
	| { readonly kind: "broken"; readonly absoluteRoot: string }
	| { readonly kind: "stale"; readonly absoluteRoot: string }
	| { readonly kind: "absent" };

interface DiscoveredRoot {
	readonly absoluteRoot: string;
	readonly relativeRoot: string;
	readonly gitBacked: boolean;
	readonly state: DiscoveryRoot["state"];
	readonly sourceIdentity: string;
	readonly privateRepositoryId: string;
	readonly treeId: string | null;
	readonly gitlinkOid?: string;
}

export interface RootTopology {
	readonly workspaceIdentity: string;
	readonly roots: readonly DiscoveryRoot[];
	readonly fingerprint: string;
	/** 本次扫描检查的目录数，仅供性能诊断，不参与 identity/fingerprint。 */
	readonly directoriesVisited?: number;
}

/**
 * discover 调用原因：区分安全快照、恢复前、可见路径枚举、恢复后与补偿路径。
 * 扫描行为不依赖该标签，它只作为调用方诊断与调用次数回归的归属标记。
 */
export type RootDiscoveryReason =
	| "safety-snapshot"
	| "restore-pre"
	| "visible-paths-pre"
	| "visible-paths-post"
	| "restore-post"
	| "compensation"
	| "settled-capture"
	| "unspecified";

export type RootDiscoveryErrorCode = "workspace_not_found" | "discovery_failed";

export class RootDiscoveryError extends Error {
	readonly code: RootDiscoveryErrorCode;

	constructor(code: RootDiscoveryErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RootDiscoveryError";
		this.code = code;
	}
}

export interface RootDiscovery {
	discover(workspaceRoot: string, reason?: RootDiscoveryReason): Promise<RootTopology>;
}

export class RootDiscovery {
	private readonly git: GitRunner;
	private lastDirectoryCount: number | undefined;
	private readonly nativeScan: NativeDirectoryScanPort;
	/** 最近一次 discover 实际使用 native 扫描时的变更游标；TS 回退必须视为不可用。 */
	private lastChangeCursor: NativeChangeCursor | undefined;
	private lastTopology: RootTopology | undefined;
	/** 共享盘 TypeScript 扫描的目录项缓存；ignored 扫描与恢复前后发现复用同一份。 */
	readonly listingCache = new DirectoryListingCache();

	constructor(git = new GitRunner(), nativeScan: NativeDirectoryScanPort = new NativeDirectoryScanner()) {
		this.git = git;
		this.nativeScan = nativeScan;
	}

	/** 常驻扫描预热：仅对后续会选择 native 的大目录树启动 helper。 */
	warmScanCache(workspaceRoot: string): void {
		if (this.lastDirectoryCount === undefined || this.lastDirectoryCount < NATIVE_SCAN_MIN_DIRECTORIES) return;
		this.nativeScan.prewarm?.(workspaceRoot);
	}

	/** ignored 分区与拓扑发现共享常驻目录缓存，但每次请求都重新核验事件。 */
	async scanIgnoredLeaves(workspaceRoot: string, roots: readonly string[]): Promise<string[] | undefined> {
		return this.nativeScan.scanLeaves?.(workspaceRoot, roots);
	}

	/** 最近一次 native 拓扑扫描的变更游标；旧 helper 或 TS 扫描返回 undefined。 */
	changeCursor(): NativeChangeCursor | undefined {
		return this.lastChangeCursor;
	}

	/** 查询自基线捕获以来的可信文件/目录变化；不可用时返回 undefined。 */
	async changesSince(workspaceRoot: string, cursor: NativeChangeCursor) {
		const canonical = await canonicalWorkspaceRoot(workspaceRoot);
		return this.nativeScan.changesSince?.(canonical, cursor);
	}

	/** 仅重置常驻 helper 看门狗；失败不影响结算。 */
	keepAlive(): void {
		this.nativeScan.keepAlive?.();
	}

	/** 关闭 native 常驻扫描客户端。 */
	async dispose(): Promise<void> {
		await this.nativeScan.dispose?.();
	}

	async discover(workspaceRoot: string, reason: RootDiscoveryReason = "unspecified"): Promise<RootTopology> {
		checkOperation();
		reportOperationProgress(`discover_roots:${reason}`);
		const workspaceIdentity = await canonicalWorkspaceRoot(workspaceRoot);
		checkOperation();
		if (reason === "restore-pre") {
			const reused = await this.reuseRestoreTopology(workspaceIdentity);
			if (reused !== undefined) return reused;
		}
		const activeRoots = new Map<string, DiscoveredRoot>();
		const nestedRoots = new Map<string, DiscoveredRoot>();
		// 子目录扫描不读取外层仓库信息；两项都结束后仍按外层优先的顺序解析 gitlink。
		const [outerRepository] = await allCompleted([
			this.inspectRepository(workspaceIdentity, workspaceIdentity),
			this.scanDirectory(workspaceIdentity, workspaceIdentity, nestedRoots),
		] as const);
		if (outerRepository.kind === "active") {
			activeRoots.set(
				outerRepository.repository.absoluteRoot,
				this.activeRoot(workspaceIdentity, outerRepository.repository),
			);
		} else if (outerRepository.kind === "broken" || outerRepository.kind === "stale") {
			activeRoots.set(outerRepository.absoluteRoot, brokenRoot(workspaceIdentity, outerRepository.absoluteRoot));
		} else {
			activeRoots.set(workspaceIdentity, syntheticRoot(workspaceIdentity));
		}

		for (const [path, root] of nestedRoots) activeRoots.set(path, root);
		checkOperation();
		reportOperationProgress("discover_gitlinks");
		const gitlinkRoots = await this.discoverGitlinks(workspaceIdentity, activeRoots);
		checkOperation();
		const roots = buildRoots([...activeRoots.values(), ...gitlinkRoots.values()]);
		const topology: RootTopology = {
			workspaceIdentity,
			roots,
			fingerprint: topologyFingerprint(workspaceIdentity, roots),
			directoriesVisited: this.lastDirectoryCount ?? 0,
		};
		this.lastTopology = topology;
		return topology;
	}

	private async reuseRestoreTopology(workspaceIdentity: string): Promise<RootTopology | undefined> {
		const previous = this.lastTopology;
		const cursor = this.lastChangeCursor;
		if (previous === undefined || previous.workspaceIdentity !== workspaceIdentity || cursor === undefined ||
			previous.roots.length === 0 || previous.roots.some((root) =>
				!root.gitBacked || root.state !== "active" || root.gitlinkOid !== undefined)) return undefined;
		const readChanges = async () => {
			try {
				return await this.nativeScan.changesSince?.(workspaceIdentity, cursor);
			} catch {
				checkOperation();
				return undefined;
			}
		};
		const changes = await readChanges();
		if (!topologyChangeSetIsStable(changes, cursor)) return undefined;

		const activeRoots = new Map<string, DiscoveredRoot>();
		for (const root of previous.roots) {
			checkOperation();
			const absoluteRoot = root.relativeRoot === "."
				? workspaceIdentity : join(workspaceIdentity, root.relativeRoot);
			const inspection = await this.inspectRepository(absoluteRoot, workspaceIdentity);
			if (inspection.kind !== "active" || inspection.repository.absoluteRoot !== absoluteRoot) return undefined;
			const discovered = this.activeRoot(workspaceIdentity, inspection.repository);
			activeRoots.set(absoluteRoot, discovered);
		}
		const gitlinkRoots = await this.discoverGitlinks(workspaceIdentity, activeRoots);
		if (gitlinkRoots.size > 0 || [...activeRoots.values()].some((root) => root.gitlinkOid !== undefined)) {
			return undefined;
		}
		const finalChanges = await readChanges();
		if (!topologyChangeSetIsStable(finalChanges, cursor)) return undefined;
		this.lastChangeCursor = { sequence: finalChanges!.sequence, instance: finalChanges!.instance };
		const roots = buildRoots([...activeRoots.values()]);
		const topology: RootTopology = {
			workspaceIdentity,
			roots,
			fingerprint: topologyFingerprint(workspaceIdentity, roots),
			directoriesVisited: previous.directoriesVisited,
		};
		this.lastTopology = topology;
		return topology;
	}

	private async scanDirectory(
		workspaceIdentity: string,
		directory: string,
		activeRoots: Map<string, DiscoveredRoot>,
	): Promise<void> {
		let level: Array<{ readonly path: string; readonly inspect: boolean }> = [{ path: directory, inspect: false }];
		let scanned = 0;
		reportOperationProgress("scan_directories");
		// 上次规模只选择执行器；小工作区仍完整重扫，目录增长后会重新使用 native。
		const native = this.lastDirectoryCount !== undefined && this.lastDirectoryCount < NATIVE_SCAN_MIN_DIRECTORIES
			? undefined : await this.nativeScan.scan(workspaceIdentity);
		this.lastChangeCursor = native?.changeSequence === undefined || native.changeInstance === undefined
			? undefined
			: { sequence: native.changeSequence, instance: native.changeInstance };
		if (native !== undefined) {
			this.lastDirectoryCount = native.directories;
			for (let index = 0; index < native.repositories.length; index += DIRECTORY_SCAN_CONCURRENCY) {
				await allCompleted(native.repositories.slice(index, index + DIRECTORY_SCAN_CONCURRENCY).map(async (candidate) => {
					checkOperation();
					const path = join(workspaceIdentity, candidate.path);
					await assertNativeCandidate(path, candidate);
					const inspection = await this.inspectRepository(path, workspaceIdentity);
					await assertNativeCandidate(path, candidate);
					this.recordInspection(workspaceIdentity, inspection, activeRoots);
				}));
			}
			reportOperationProgress(`scan_directories:${native.directories}`);
			return;
		}
		while (level.length > 0) {
			checkOperation();
			const next: Array<{ readonly path: string; readonly inspect: true }> = [];
			for (let index = 0; index < level.length; index += DIRECTORY_SCAN_CONCURRENCY) {
				checkOperation();
				const children = await allCompleted(level.slice(index, index + DIRECTORY_SCAN_CONCURRENCY).map(
					(candidate) => this.scanDirectoryNode(workspaceIdentity, candidate, activeRoots),
				));
				for (const group of children) next.push(...group);
				scanned += children.length;
				reportOperationProgress(`scan_directories:${scanned}`);
			}
			level = next;
		}
		this.lastDirectoryCount = scanned;
	}

	private async scanDirectoryNode(
		workspaceIdentity: string,
		candidate: { readonly path: string; readonly inspect: boolean },
		activeRoots: Map<string, DiscoveredRoot>,
	): Promise<Array<{ readonly path: string; readonly inspect: true }>> {
		checkOperation();
		// 缓存层每次都 lstat，并在 dev/ino/mtime/ctime 不变时复用目录项；真实路径边界每次仍复核。
		const listing = await this.listingCache.list(candidate.path);
		if (listing === undefined ||
			!isWithin(workspaceIdentity, await realpath(candidate.path).catch(() => ""))) return [];
		const entries = listing.entries;
		// 使用这次枚举识别候选；遇到大小写变体仍由文件系统对 .git 的实际查找决定。
		if (candidate.inspect && entries.some((entry) => entry.name.toLowerCase() === ".git")) {
			checkOperation();
			const inspection = await this.inspectRepository(candidate.path, workspaceIdentity);
			if (!await isSafeDirectory(candidate.path, workspaceIdentity)) return [];
			this.recordInspection(workspaceIdentity, inspection, activeRoots);
		}
		return entries
			.filter((entry) => entry.name !== ".git" && entry.kind === "directory")
			.map((entry) => ({ path: join(candidate.path, entry.name), inspect: true as const }));
	}

	private recordInspection(
		workspaceIdentity: string,
		inspection: RepositoryInspection,
		activeRoots: Map<string, DiscoveredRoot>,
	): void {
		if (inspection.kind === "active") {
			activeRoots.set(inspection.repository.absoluteRoot, this.activeRoot(workspaceIdentity, inspection.repository));
		} else if (inspection.kind === "broken") {
			activeRoots.set(inspection.absoluteRoot, brokenRoot(workspaceIdentity, inspection.absoluteRoot));
		} else if (inspection.kind === "stale") {
			activeRoots.set(inspection.absoluteRoot, staleWorktreeRoot(workspaceIdentity, inspection.absoluteRoot));
		}
	}

	private async inspectRepository(candidate: string, workspaceIdentity: string): Promise<RepositoryInspection> {
		const marker = await gitMarkerState(candidate);
		if (marker === "absent") {
			return { kind: "absent" };
		}

		let absoluteRoot: string;
		try {
			absoluteRoot = await realpath(candidate);
		} catch {
			return { kind: "broken", absoluteRoot: resolve(candidate) };
		}
		if (!isWithin(workspaceIdentity, absoluteRoot)) {
			return { kind: "absent" };
		}
		if (marker === "invalid") {
			return { kind: "broken", absoluteRoot };
		}
		if (await deadWorktreePointer(absoluteRoot)) {
			return { kind: "stale", absoluteRoot };
		}

		const details = await this.gitOutput([
			"-C",
			absoluteRoot,
			"rev-parse",
			"--show-toplevel",
			"--git-dir",
			"--git-common-dir",
			"HEAD",
		]);
		if (details === null) {
			// unborn repository 没有 HEAD；保留旧行为：root 仍可作为 active，但 treeId 为空。
			const metadata = await this.gitOutput([
				"-C",
				absoluteRoot,
				"rev-parse",
				"--show-toplevel",
				"--git-dir",
				"--git-common-dir",
			]);
			if (metadata === null) return { kind: "broken", absoluteRoot };
			const metadataLines = metadata.trimEnd().split("\n");
			if (metadataLines.length < 3) return { kind: "broken", absoluteRoot };
			const remote = await this.gitOutput(["-C", absoluteRoot, "config", "--get", "remote.origin.url"]);
			return {
				kind: "active",
				repository: {
					absoluteRoot,
					commonGitDir: resolve(absoluteRoot, metadataLines[2]),
					sourceIdentity: remote?.trim() || `git:${resolve(absoluteRoot, metadataLines[2])}`,
					treeId: null,
				},
			};
		}
		const lines = details.trimEnd().split("\n");
		if (lines.length < 3) {
			return { kind: "broken", absoluteRoot };
		}
		try {
			if ((await realpath(lines[0])) !== absoluteRoot) {
				return { kind: "broken", absoluteRoot };
			}
		} catch {
			return { kind: "broken", absoluteRoot };
		}

		const commonGitDir = resolve(absoluteRoot, lines[2]);
		const remote = await this.gitOutput(["-C", absoluteRoot, "config", "--get", "remote.origin.url"]);
		const head = lines[3] !== undefined && /^[0-9a-f]{40,64}$/.test(lines[3]) ? lines[3] : null;
		return {
			kind: "active",
			repository: {
				absoluteRoot,
				commonGitDir,
				sourceIdentity: remote?.trim() || `git:${commonGitDir}`,
				treeId: head?.trim() || null,
			},
		};
	}

	private activeRoot(workspaceIdentity: string, repository: RepositoryInfo): DiscoveredRoot {
		return {
			absoluteRoot: repository.absoluteRoot,
			relativeRoot: workspaceRelativePath(workspaceIdentity, repository.absoluteRoot),
			gitBacked: true,
			state: "active",
			sourceIdentity: repository.sourceIdentity,
			privateRepositoryId: checksum(repository.sourceIdentity),
			treeId: repository.treeId,
		};
	}

	private async discoverGitlinks(
		workspaceIdentity: string,
		activeRoots: Map<string, DiscoveredRoot>,
	): Promise<Map<string, DiscoveredRoot>> {
		const result = new Map<string, DiscoveredRoot>();
		for (const root of activeRoots.values()) {
			checkOperation();
			if (!root.gitBacked || root.state !== "active") {
				continue;
			}
			const stage = await this.gitOutput(["-C", root.absoluteRoot, "ls-files", "--stage", "-z"]);
			if (stage === null) {
				throw new RootDiscoveryError("discovery_failed", "无法读取 Git index");
			}
			for (const gitlink of parseGitlinks(stage)) {
				const absolutePath = resolve(root.absoluteRoot, gitlink.relativePath);
				if (!isWithin(workspaceIdentity, absolutePath)) {
					continue;
				}
				const relativeRoot = workspaceRelativePath(workspaceIdentity, absolutePath);
				const existing = [...activeRoots.entries()].find(([, candidate]) => candidate.relativeRoot === relativeRoot);
				if (existing !== undefined) {
					activeRoots.set(existing[0], { ...existing[1], gitlinkOid: gitlink.oid });
					continue;
				}
				const state = await gitlinkState(absolutePath);
				const sourceIdentity = `${root.sourceIdentity}:${relativeRoot}`;
				result.set(relativeRoot, {
					absoluteRoot: absolutePath,
					relativeRoot,
					gitBacked: true,
					state,
					sourceIdentity,
					privateRepositoryId: checksum(sourceIdentity),
					treeId: null,
					gitlinkOid: gitlink.oid,
				});
			}
		}
		return result;
	}

	private async gitOutput(args: readonly string[]): Promise<string | null> {
		try {
			const result = await this.git.run(["-c", "core.fsmonitor=false", ...args], {
				env: cleanGitEnvironment(),
			});
			if (result.aborted || result.timedOut) {
				// 取消/超时不应被当成"仓库损坏"；有 context 时在这里重新抛出具体原因。
				checkOperation();
			}
			return result.killed ? null : result.stdout;
		} catch (error) {
			if (error instanceof GitRunError && error.code === "git_termination_failed") {
				// 无法证明子进程已停止：上层必须保留 lease 并走恢复，不能继续扫描。
				throw error;
			}
			if (error instanceof OperationError) {
				throw error;
			}
			return null;
		}
	}
}

function topologyChangeSetIsStable(
	changes: NativeChangeSet | undefined,
	cursor: NativeChangeCursor,
): changes is NativeChangeSet {
	return changes !== undefined && changes.trusted && changes.instance === cursor.instance &&
		changes.sequence >= cursor.sequence && changes.directories.length === 0 &&
		!changes.files.some((path) => path.split("/").at(-1)?.toLowerCase() === ".git");
}

async function assertNativeCandidate(path: string, candidate: NativeRepositoryCandidate): Promise<void> {
	try {
		const metadata = await lstat(path, { bigint: true });
		if (!metadata.isDirectory() || metadata.dev !== candidate.dev || metadata.ino !== candidate.ino ||
			await realpath(path) !== path) {
			throw new RootDiscoveryError("discovery_failed", `native 扫描后仓库目录身份发生变化：${candidate.path}`);
		}
	} catch (error) {
		if (error instanceof RootDiscoveryError) throw error;
		throw new RootDiscoveryError("discovery_failed", `无法复核 native 仓库候选：${candidate.path}`, { cause: error });
	}
}

function syntheticRoot(workspaceIdentity: string): DiscoveredRoot {
	return {
		absoluteRoot: workspaceIdentity,
		relativeRoot: ".",
		gitBacked: false,
		state: "active",
		sourceIdentity: workspaceIdentity,
		privateRepositoryId: checksum(workspaceIdentity),
		treeId: null,
	};
}

function brokenRoot(workspaceIdentity: string, absoluteRoot: string): DiscoveredRoot {
	const relativeRoot = workspaceRelativePath(workspaceIdentity, absoluteRoot);
	const sourceIdentity = `broken:${absoluteRoot}`;
	return {
		absoluteRoot,
		relativeRoot,
		gitBacked: false,
		state: "broken",
		sourceIdentity,
		privateRepositoryId: checksum(sourceIdentity),
		treeId: null,
	};
}

// git worktree 的 .git 文件是 "gitdir: <path>" 指针；项目从其他机器/位置搬移后，
// 指针常指向本机不存在的 gitdir（例如虚拟机共享目录的绝对路径）。这种可证明失效的
// 指针不再代表可用仓库，按未初始化根处理：内容不进入快照，也不会被 restore 触碰。
async function deadWorktreePointer(absoluteRoot: string): Promise<boolean> {
	const pointerPath = join(absoluteRoot, ".git");
	let content: string;
	try {
		const marker = await lstat(pointerPath);
		if (!marker.isFile()) return false;
		content = await readFile(pointerPath, "utf8");
	} catch {
		return false;
	}
	if (content.length > GIT_POINTER_MAX_BYTES) return false;
	const firstLine = content.split("\n", 1)[0] ?? "";
	const match = /^gitdir: (.+)$/.exec(firstLine.trimEnd());
	if (match === null) return false;
	const gitDirectory = isAbsolute(match[1]) ? resolve(match[1]) : resolve(absoluteRoot, match[1]);
	try {
		await stat(gitDirectory);
		return false;
	} catch (error) {
		return hasErrorCode(error, "ENOENT");
	}
}

function staleWorktreeRoot(workspaceIdentity: string, absoluteRoot: string): DiscoveredRoot {
	const relativeRoot = workspaceRelativePath(workspaceIdentity, absoluteRoot);
	const sourceIdentity = `stale-worktree:${absoluteRoot}`;
	return {
		absoluteRoot,
		relativeRoot,
		gitBacked: true,
		state: "uninitialized",
		sourceIdentity,
		privateRepositoryId: checksum(sourceIdentity),
		treeId: null,
	};
}

function buildRoots(discovered: readonly DiscoveredRoot[]): DiscoveryRoot[] {
	const unique = new Map<string, DiscoveredRoot>();
	for (const root of discovered) {
		unique.set(root.relativeRoot, root);
	}
	const paths = [...unique.keys()].sort(comparePaths);
	return paths.map((relativeRoot) => {
		const root = unique.get(relativeRoot) as DiscoveredRoot;
		const parentRoot = paths
			.filter((candidate) => isStrictAncestor(candidate, relativeRoot))
			.sort((left, right) => right.length - left.length || comparePaths(left, right))[0] ?? null;
		return {
			relativeRoot,
			parentRoot,
			state: root.state,
			sourceIdentity: root.sourceIdentity,
			privateRepositoryId: root.privateRepositoryId,
			treeId: root.treeId,
			gitBacked: root.gitBacked,
			...(root.gitlinkOid === undefined ? {} : { gitlinkOid: root.gitlinkOid }),
		};
	});
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
	try {
		return await realpath(workspaceRoot);
	} catch {
		throw new RootDiscoveryError("workspace_not_found", "workspace 根目录不存在");
	}
}

async function gitMarkerState(candidate: string): Promise<"absent" | "safe" | "invalid"> {
	try {
		const marker = await lstat(join(candidate, ".git"));
		if (marker.isSymbolicLink()) {
			return "invalid";
		}
		return marker.isDirectory() || marker.isFile() ? "safe" : "invalid";
	} catch (error) {
		return hasErrorCode(error, "ENOENT") ? "absent" : "invalid";
	}
}

async function isSafeDirectory(directory: string, workspaceIdentity: string): Promise<boolean> {
	try {
		const metadata = await lstat(directory);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			return false;
		}
		return isWithin(workspaceIdentity, await realpath(directory));
	} catch {
		return false;
	}
}

async function gitlinkState(absolutePath: string): Promise<DiscoveryRoot["state"]> {
	try {
		await lstat(absolutePath);
	} catch {
		return "uninitialized";
	}
	// git worktree / 部分 checkout 会为 gitlink 留下空目录骨架（可能含指向共享依赖的 symlink）；
	// 内容寻址快照只跟踪文件，不含任何文件的目录与未初始化等价，避免整个 workspace 无法快照。
	return (await directoryTreeContainsFile(absolutePath)) ? "broken" : "uninitialized";
}

const SKELETON_NOISE_FILES = new Set([".DS_Store", "desktop.ini", "Thumbs.db"]);

async function directoryTreeContainsFile(directory: string): Promise<boolean> {
	checkOperation();
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return true;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (await directoryTreeContainsFile(join(directory, entry.name))) return true;
		} else if (entry.isSymbolicLink() || SKELETON_NOISE_FILES.has(entry.name)) {
			// symlink 不适随也不计内容：uninitialized 根下的内容不被捕获也不会被 restore 触碰，
			// 原样保留不会丢失；OS 噪音文件不应让整个 workspace 无法快照。
			continue;
		} else {
			return true;
		}
	}
	return false;
}

function cleanGitEnvironment(): Readonly<Record<string, string | undefined>> {
	return {
		GIT_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_OBJECT_DIRECTORY: undefined,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
		GIT_NAMESPACE: undefined,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_COUNT: undefined,
		GIT_CONFIG_PARAMETERS: undefined,
		GIT_CONFIG_SYSTEM: undefined,
		GIT_CONFIG_GLOBAL: undefined,
		GIT_CONFIG_NOSYSTEM: undefined,
		GIT_ATTR_NOSYSTEM: undefined,
	};
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseGitlinks(stage: string): Array<{ oid: string; relativePath: string }> {
	const gitlinks: Array<{ oid: string; relativePath: string }> = [];
	for (const entry of stage.split("\0")) {
		if (entry.length === 0) {
			continue;
		}
		const separator = entry.indexOf("\t");
		if (separator < 0) {
			continue;
		}
		const metadata = entry.slice(0, separator).split(" ");
		if (metadata[0] !== "160000" || metadata.length < 2) {
			continue;
		}
		gitlinks.push({ oid: metadata[1], relativePath: entry.slice(separator + 1) });
	}
	return gitlinks;
}

function workspaceRelativePath(workspaceIdentity: string, absolutePath: string): string {
	const value = relative(workspaceIdentity, absolutePath);
	return value.length === 0 ? "." : value.split(sep).join("/");
}

function isWithin(parent: string, candidate: string): boolean {
	const value = relative(parent, candidate);
	return value.length === 0 || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isStrictAncestor(parent: string, child: string): boolean {
	return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
