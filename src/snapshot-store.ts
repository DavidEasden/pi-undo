import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { fsyncDirectory, writeContentAddressed, writeJsonAtomic } from "./atomic-fs.ts";
import {
	assertManifest,
	canonicalJson,
	checksum,
	ignoredPresentClosure,
	topologyFingerprint,
} from "./encoding.ts";
import { GitRunner, type GitRunOptions } from "./git-runner.ts";
import type {
	DiscoveryRoot,
	ManifestId,
	RestorePath,
	RootTopologyIdentity,
	SnapshotManifest,
	SnapshotRoot,
} from "./model.ts";
import { assertNoSymlinkEscape, relativeSafePath } from "./path-safety.ts";
import { RootDiscovery, type RootTopology } from "./root-discovery.ts";
import { WorkspaceLock } from "./workspace-lock.ts";

const SCHEMA_VERSION = 1;
const COMPLETE_COVERAGE = "complete";
const MANIFEST_SUFFIX = ".json";
const GC_METADATA_FILE = "gc.json";
const GC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const IGNORE_POLICY = "git-check-ignore-v1";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const TREE_CACHE_LIMIT = 256;
const TREE_BLOB_MEMBERSHIP_LIMIT = 65_536;
const HASH_BATCH_MAX_PATHS = process.platform === "win32" ? 128 : 2_048;
const HASH_BATCH_MAX_ARGUMENT_BYTES = process.platform === "win32" ? 24 * 1024 : 128 * 1024;
const HASH_BATCH_CONCURRENCY = 4;
const FILE_SYSTEM_INSPECTION_CONCURRENCY = 32;
const INDEX_BATCH_MAX_ENTRIES = 4_096;
const INDEX_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const BLOB_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_BATCH_MAX_ENTRIES = 256;

interface PinRecord {
	readonly schemaVersion: 1;
	readonly manifestId: ManifestId;
	readonly reasons: readonly string[];
	readonly updatedAt: string;
}

interface StoreGcRecord {
	readonly schemaVersion: 1;
	readonly lastUsedAt: number;
	readonly cleanupPending?: boolean;
}

interface CapturedTreeEntry {
	readonly mode: number;
	readonly objectId: string;
	readonly size: number;
	readonly relativePath: string;
}

interface CapturedRootResult {
	readonly treeId: string;
	readonly coverage: string;
	readonly ignorePolicy: string;
	readonly ignoredPresentPaths: readonly string[];
	readonly ignoreClosure: string;
	readonly objectClosure: string;
}

interface VisibleLeaf {
	readonly relativePath: string;
	readonly kind: "file" | "symlink";
	readonly mode: number;
	readonly fingerprint: string;
}

interface CachedBlob {
	readonly promise: Promise<Uint8Array>;
	size: number;
}

export interface SnapshotStoreOptions {
	readonly storeRoot?: string;
	readonly git?: GitRunner;
	readonly discovery?: RootDiscovery;
	readonly lock?: WorkspaceLock;
	readonly clock?: () => number;
}

export interface CaptureOptions {
	readonly excludePaths?: readonly string[];
}

export type SnapshotStoreErrorCode =
	| "capture_failed"
	| "invalid_manifest_id"
	| "manifest_not_found"
	| "manifest_invalid"
	| "object_missing"
	| "root_not_found"
	| "invalid_pin";

export class SnapshotStoreError extends Error {
	readonly code: SnapshotStoreErrorCode;

	constructor(code: SnapshotStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SnapshotStoreError";
		this.code = code;
	}
}

export interface SnapshotStore {
	capture(topology: RootTopology, scope?: readonly string[], options?: CaptureOptions): Promise<SnapshotManifest>;
	listVisibleLeafPaths(topology: RootTopology, options?: CaptureOptions): Promise<readonly string[]>;
	loadManifest(id: ManifestId): Promise<SnapshotManifest>;
	assertComplete(id: ManifestId, scopePaths?: readonly string[]): Promise<void>;
	listTree(id: ManifestId, root: string, rootScopePaths?: readonly string[]): Promise<readonly RestorePath[]>;
	readBlob(id: ManifestId, root: string, blobId: string, relativePath?: string): Promise<Uint8Array>;
	pin(id: ManifestId, reason: string): Promise<void>;
	unpin(id: ManifestId, reason: string): Promise<void>;
	collectGarbage(): Promise<number>;
	durableCacheDirectory(): Promise<string>;
}

export class SnapshotStore {
	private readonly storeRoot: string;
	private readonly storesRoot: string;
	private readonly git: GitRunner;
	private readonly discovery: RootDiscovery;
	private readonly lock: WorkspaceLock;
	private readonly clock: () => number;
	private readonly manifestLocations = new Map<string, string>();
	// Tree 与 blob 都由 object ID 内容寻址；缓存只复用已从私有 ODB 读取的不可变内容。
	private readonly treeEntriesCache = new Map<string, Promise<CapturedTreeEntry[]>>();
	private readonly treeBlobMembership = new Map<string, string>();
	private readonly blobCache = new Map<string, CachedBlob>();
	private blobCacheBytes = 0;

	constructor(options: SnapshotStoreOptions = {}) {
		this.storeRoot = resolve(options.storeRoot ?? join(tmpdir(), "pi-undo-snapshot-store"));
		this.storesRoot = join(this.storeRoot, "stores");
		this.git = options.git ?? new GitRunner();
		this.discovery = options.discovery ?? new RootDiscovery(this.git);
		this.lock = options.lock ?? new WorkspaceLock();
		this.clock = options.clock ?? Date.now;
	}

	async durableCacheDirectory(): Promise<string> {
		const directory = join(this.storeRoot, "durable-cache");
		await mkdir(directory, { recursive: true });
		return directory;
	}

	async capture(
		topology: RootTopology,
		scope?: readonly string[],
		options: CaptureOptions = {},
	): Promise<SnapshotManifest> {
		await this.assertPrivateStore(topology.workspaceIdentity);
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.captureLocked(topology, scope, options));
	}

	private async captureLocked(
		topology: RootTopology,
		scope: readonly string[] | undefined,
		options: CaptureOptions,
	): Promise<SnapshotManifest> {
		let transactionDirectory: string | undefined;
		try {
			if (topology.fingerprint !== topologyFingerprint(topology.workspaceIdentity, topology.roots)) {
				throw new SnapshotStoreError("capture_failed", "topology fingerprint 与 roots 不匹配");
			}
			const coverage = captureCoverage(topology.workspaceIdentity, scope);
			const artifactExclusions = captureExclusions(topology.workspaceIdentity, options.excludePaths);
			await this.assertTopology(topology, "捕获前 topology 已变化");
			if (topology.roots.some((root) => root.state === "broken")) {
				throw new SnapshotStoreError("capture_failed", "broken root 不能静默进入快照");
			}

			const storeDirectory = this.storeDirectory(topology);
			const transactionsRoot = join(storeDirectory, "transactions");
			await mkdir(transactionsRoot, { recursive: true });
			transactionDirectory = await mkdtemp(join(transactionsRoot, "capture-"));

			const roots: SnapshotRoot[] = [];
			for (const root of topology.roots) {
				if (root.state !== "active") {
					const coverage = rootCaptureCoverage(root.relativeRoot, scope);
					roots.push(snapshotRoot(root, {
						treeId: null,
						coverage,
						...ignoredPresentProof(coverage, []),
						objectClosure: inactiveRootClosure(root),
					}));
					continue;
				}
				const captured = await this.captureRoot(
					topology,
					root,
					transactionDirectory,
					scope,
					artifactExclusions,
				);
				roots.push(snapshotRoot(root, captured));
			}

			await this.assertTopology(topology, "捕获期间 topology 已变化");
			const content = {
				schemaVersion: SCHEMA_VERSION as 1,
				workspaceIdentity: topology.workspaceIdentity,
				topologyFingerprint: topology.fingerprint,
				coverage,
				roots,
				createdAt: new Date(this.clock()).toISOString(),
			};
			const manifestId = checksum(canonicalJson(content)) as ManifestId;
			const manifest: SnapshotManifest = { ...content, manifestId };
			assertManifest(manifest);

			const manifestPath = join(storeDirectory, "manifests", `${manifestId}${MANIFEST_SUFFIX}`);
			await this.touchStore(storeDirectory);
			await writeContentAddressed(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));
			this.manifestLocations.set(manifestId, manifestPath);
			return manifest;
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("capture_failed", errorMessage(error), { cause: error });
		} finally {
			if (transactionDirectory !== undefined) {
				await rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
			}
		}
	}

	async listVisibleLeafPaths(
		topology: RootTopology,
		options: CaptureOptions = {},
	): Promise<readonly string[]> {
		await this.assertPrivateStore(topology.workspaceIdentity);
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.listVisibleLeafPathsLocked(topology, options));
	}

	private async listVisibleLeafPathsLocked(
		topology: RootTopology,
		options: CaptureOptions,
	): Promise<readonly string[]> {
		let transactionDirectory: string | undefined;
		try {
			if (topology.fingerprint !== topologyFingerprint(topology.workspaceIdentity, topology.roots)) {
				throw new SnapshotStoreError("capture_failed", "topology fingerprint 与 roots 不匹配");
			}
			const artifactExclusions = captureExclusions(topology.workspaceIdentity, options.excludePaths);
			await this.assertTopology(topology, "可见路径枚举前 topology 已变化");
			if (topology.roots.some((root) => root.state === "broken")) {
				throw new SnapshotStoreError("capture_failed", "broken root 不能静默进入可见路径枚举");
			}

			const storeDirectory = this.storeDirectory(topology);
			const transactionsRoot = join(storeDirectory, "transactions");
			await mkdir(transactionsRoot, { recursive: true });
			transactionDirectory = await mkdtemp(join(transactionsRoot, "visible-"));
			const result = new Set<string>();
			for (const root of topology.roots) {
				if (root.state !== "active") continue;
				const gitDirectory = this.rootGitDirectory(storeDirectory, root);
				await this.ensurePrivateRepository(gitDirectory);
				await this.assertNoAlternates(gitDirectory);
				const absoluteRoot = workspaceRootPath(topology.workspaceIdentity, root.relativeRoot);
				const indexPath = join(transactionDirectory, `${rootStoreId(root)}.index`);
				const environment = privateGitEnvironment(gitDirectory, absoluteRoot, indexPath);
				await this.runGit(["read-tree", "--empty"], { cwd: absoluteRoot, env: environment });
				await this.validateIgnoreQuery(absoluteRoot, environment, root.gitBacked);
				const exclusions = topology.roots
					.filter((candidate) => isStrictRootAncestor(root.relativeRoot, candidate.relativeRoot))
					.map((candidate) => rootRelativePath(root.relativeRoot, candidate.relativeRoot));
				const exactExclusions = ownedArtifactExclusions(topology.roots, root.relativeRoot, artifactExclusions);
				for (const relativePath of await this.queryVisibleLeafPaths(
					absoluteRoot,
					environment,
					root.gitBacked,
					[],
					exclusions,
					exactExclusions,
					true,
				)) {
					result.add(workspaceRelativePath(root.relativeRoot, relativePath));
				}
			}
			await this.assertTopology(topology, "可见路径枚举期间 topology 已变化");
			return [...result].sort(comparePaths);
		} catch (error) {
			if (error instanceof SnapshotStoreError) throw error;
			throw new SnapshotStoreError("capture_failed", errorMessage(error), { cause: error });
		} finally {
			if (transactionDirectory !== undefined) {
				await rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
			}
		}
	}

	async loadManifest(id: ManifestId): Promise<SnapshotManifest> {
		const manifestPath = await this.findManifestPath(id);
		try {
			const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
			const manifest = assertManifest(value);
			if (manifest.manifestId !== id) {
				throw new SnapshotStoreError("manifest_invalid", "manifest 文件名与内容 ID 不一致");
			}
			return manifest;
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("manifest_invalid", "manifest 无法读取或校验", { cause: error });
		}
	}

	async assertComplete(id: ManifestId, scopePaths?: readonly string[]): Promise<void> {
		const manifestPath = await this.findManifestPath(id);
		const manifest = await this.loadManifest(id);
		const storeDirectory = dirname(dirname(manifestPath));
		try {
			for (const root of manifest.roots) {
				if (
					root.ignorePolicy !== IGNORE_POLICY ||
					root.ignoreClosure !== ignoredPresentClosure(root) ||
					root.objectClosure === undefined
				) {
					throw new SnapshotStoreError("object_missing", "manifest root 元数据不受支持");
				}
				if (root.state !== "active" || root.treeId === null) {
					if (root.objectClosure !== inactiveRootClosure(root)) {
						throw new SnapshotStoreError("object_missing", "非活动 root 的对象闭包校验失败");
					}
					continue;
				}
				const rootScope = rootRelativeScope(root.relativeRoot, scopePaths);
				if (rootScope !== undefined && rootScope.length === 0) continue;
				const gitDirectory = this.rootGitDirectory(storeDirectory, root);
				await this.assertNoAlternates(gitDirectory);
				const entries = await this.readTreeEntries(gitDirectory, root.treeId, rootScope);
				if (root.ignoredPresentPaths.some((ignoredPath) => entries.some(
					(entry) => isPathAtOrBelow(ignoredPath, entry.relativePath) ||
						isPathAtOrBelow(entry.relativePath, ignoredPath),
				))) {
					throw new SnapshotStoreError("object_missing", "ignored-present proof 与 root tree 冲突");
				}
				await this.assertObjectsComplete(gitDirectory, root.treeId, entries);
				if (scopePaths !== undefined) await this.preloadBlobBytes(gitDirectory, entries);
				if (rootScope === undefined && root.objectClosure !== treeObjectClosure(root.treeId, entries)) {
					throw new SnapshotStoreError("object_missing", "root tree 对象闭包校验失败");
				}
			}
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("object_missing", "manifest 引用的 Git 对象不完整", { cause: error });
		}
	}

	async listTree(
		id: ManifestId,
		rootPath: string,
		rootScopePaths?: readonly string[],
	): Promise<readonly RestorePath[]> {
		relativeSafePath("/", rootPath);
		const manifestPath = await this.findManifestPath(id);
		const manifest = await this.loadManifest(id);
		const root = manifest.roots.find((candidate) => candidate.relativeRoot === rootPath);
		if (root === undefined) {
			throw new SnapshotStoreError("root_not_found", "manifest 中不存在指定 root");
		}
		if (root.state !== "active" || root.treeId === null) {
			return [];
		}

		const storeDirectory = dirname(dirname(manifestPath));
		const gitDirectory = this.rootGitDirectory(storeDirectory, root);
		try {
			const treeEntries = await this.readTreeEntries(gitDirectory, root.treeId, rootScopePaths);
			const directories = new Set<string>();
			for (const entry of treeEntries) {
				const parts = entry.relativePath.split("/");
				for (let index = 1; index < parts.length; index += 1) {
					directories.add(parts.slice(0, index).join("/"));
				}
			}

			const result: RestorePath[] = [...directories].map((relativePath) => ({
				relativePath,
				kind: "directory",
				mode: 0o755,
				blobId: null,
				size: 0,
				rootHash: root.treeId as string,
			}));
			for (const entry of treeEntries) {
				const symlink = entry.mode === 0o120000;
				result.push({
					relativePath: entry.relativePath,
					kind: symlink ? "symlink" : "file",
					mode: entry.mode,
					blobId: entry.objectId,
					size: entry.size,
					rootHash: root.treeId,
					...(symlink ? { linkText: await this.readBlobText(gitDirectory, entry.objectId) } : {}),
				});
			}
			return result.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("object_missing", "root tree 无法读取", { cause: error });
		}
	}

	async readBlob(
		id: ManifestId,
		rootPath: string,
		blobId: string,
		relativePath?: string,
	): Promise<Uint8Array> {
		relativeSafePath("/", rootPath);
		if (!isObjectId(blobId)) {
			throw new SnapshotStoreError("object_missing", "blob ID 无效");
		}
		const manifestPath = await this.findManifestPath(id);
		const manifest = await this.loadManifest(id);
		const root = manifest.roots.find((candidate) => candidate.relativeRoot === rootPath);
		if (root === undefined) {
			throw new SnapshotStoreError("root_not_found", "manifest 中不存在指定 root");
		}
		if (root.state !== "active" || root.treeId === null) {
			throw new SnapshotStoreError("object_missing", "指定 root 没有可读取的 tree");
		}

		const storeDirectory = dirname(dirname(manifestPath));
		const gitDirectory = this.rootGitDirectory(storeDirectory, root);
		try {
			const safeRelativePath = relativePath === undefined ? undefined : relativeSafePath("/", relativePath);
			if (safeRelativePath === undefined) {
				const entries = await this.readTreeEntries(gitDirectory, root.treeId);
				if (!entries.some((entry) => entry.objectId === blobId)) {
					throw new SnapshotStoreError("object_missing", "blob 不属于指定 root tree");
				}
			} else {
				const membershipKey = treeBlobMembershipKey(gitDirectory, root.treeId, safeRelativePath);
				let ownedBlobId = this.treeBlobMembership.get(membershipKey);
				if (ownedBlobId === undefined) {
					await this.readTreeEntries(gitDirectory, root.treeId, [safeRelativePath]);
					ownedBlobId = this.treeBlobMembership.get(membershipKey);
				}
				if (ownedBlobId !== blobId) {
					throw new SnapshotStoreError("object_missing", "blob 不属于指定 root tree path");
				}
			}
			return new Uint8Array(await this.readBlobBytes(gitDirectory, blobId));
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("object_missing", "blob 无法读取", { cause: error });
		}
	}

	async pin(id: ManifestId, reason: string): Promise<void> {
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.pinLocked(id, reason));
	}

	private async pinLocked(id: ManifestId, reason: string): Promise<void> {
		assertPinReason(reason);
		const manifestPath = await this.findManifestPath(id);
		await this.loadManifest(id);
		const pinPath = join(dirname(dirname(manifestPath)), "pins", `${id}${MANIFEST_SUFFIX}`);
		const current = await readPin(pinPath, id);
		const reasons = [...new Set([...(current?.reasons ?? []), reason])].sort(comparePaths);
		await writeJsonAtomic(pinPath, {
			schemaVersion: SCHEMA_VERSION,
			manifestId: id,
			reasons,
			updatedAt: new Date(this.clock()).toISOString(),
		} satisfies PinRecord);
		await this.touchStore(dirname(dirname(manifestPath)));
	}

	async unpin(id: ManifestId, reason: string): Promise<void> {
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.unpinLocked(id, reason));
	}

	private async unpinLocked(id: ManifestId, reason: string): Promise<void> {
		assertPinReason(reason);
		const manifestPath = await this.findManifestPath(id);
		const pinPath = join(dirname(dirname(manifestPath)), "pins", `${id}${MANIFEST_SUFFIX}`);
		const current = await readPin(pinPath, id);
		if (current === null) {
			return;
		}
		const reasons = current.reasons.filter((candidate) => candidate !== reason);
		if (reasons.length === 0) {
			await this.touchStore(dirname(dirname(manifestPath)));
			await rm(pinPath, { force: true });
			await fsyncDirectory(dirname(pinPath));
			return;
		}
		await writeJsonAtomic(pinPath, {
			...current,
			reasons,
			updatedAt: new Date(this.clock()).toISOString(),
		});
		await this.touchStore(dirname(dirname(manifestPath)));
	}

	async collectGarbage(): Promise<number> {
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.collectGarbageLocked());
	}

	private async collectGarbageLocked(): Promise<number> {
		let stores;
		try {
			stores = await readdir(this.storesRoot, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return 0;
			}
			throw error;
		}
		const cutoff = this.clock() - GC_RETENTION_MS;
		let removed = 0;
		for (const store of stores) {
			if (!store.isDirectory() || store.isSymbolicLink()) {
				continue;
			}
			const storeDirectory = join(this.storesRoot, store.name);
			if (await hasPinnedManifest(storeDirectory)) {
				continue;
			}
			const metadata = await readGcRecord(join(storeDirectory, GC_METADATA_FILE));
			const lastUsedAt = metadata?.lastUsedAt ?? (await statMtime(storeDirectory));
			if (lastUsedAt > cutoff) {
				continue;
			}
			try {
				await rm(storeDirectory, { recursive: true, force: true });
				removed += 1;
				for (const [id, path] of this.manifestLocations) {
					if (path.startsWith(`${storeDirectory}${sep}`)) {
						this.manifestLocations.delete(id);
					}
				}
			} catch (error) {
				await writeJsonAtomic(join(storeDirectory, GC_METADATA_FILE), {
					schemaVersion: SCHEMA_VERSION,
					lastUsedAt,
					cleanupPending: true,
				} satisfies StoreGcRecord).catch(() => {});
			}
		}
		return removed;
	}

	private async captureRoot(
		topology: RootTopology,
		root: DiscoveryRoot,
		transactionDirectory: string,
		scope: readonly string[] | undefined,
		artifactExclusions: readonly string[],
	): Promise<CapturedRootResult> {
		const storeDirectory = this.storeDirectory(topology);
		const gitDirectory = this.rootGitDirectory(storeDirectory, root);
		await this.ensurePrivateRepository(gitDirectory);
		await this.assertNoAlternates(gitDirectory);

		const absoluteRoot = workspaceRootPath(topology.workspaceIdentity, root.relativeRoot);
		const indexPath = join(transactionDirectory, `${rootStoreId(root)}.index`);
		const environment = privateGitEnvironment(gitDirectory, absoluteRoot, indexPath);
		await this.runGit(["read-tree", "--empty"], { cwd: absoluteRoot, env: environment });
		await this.validateIgnoreQuery(absoluteRoot, environment, root.gitBacked);

		const requestedInclusions = rootScopePathspecs(root.relativeRoot, scope);
		const exclusions = topology.roots
			.filter((candidate) => isStrictRootAncestor(root.relativeRoot, candidate.relativeRoot))
			.map((candidate) => rootRelativePath(root.relativeRoot, candidate.relativeRoot));
		const exactExclusions = ownedArtifactExclusions(topology.roots, root.relativeRoot, artifactExclusions);
		const inclusions = ownedRootInclusions(requestedInclusions, exclusions);
		await this.stageWorktree(
			absoluteRoot,
			environment,
			root.gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
		);
		const coverage = rootCoverageFromInclusions(inclusions);
		const ignoredPresentPaths = await this.captureIgnoredPresentPaths(
			absoluteRoot,
			environment,
			root.gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
		);
		const treeId = (await this.runGit(["write-tree"], { cwd: absoluteRoot, env: environment })).trim();
		if (!isObjectId(treeId)) {
			throw new SnapshotStoreError("capture_failed", "git write-tree 未返回有效对象 ID");
		}
		const entries = await this.readTreeEntries(gitDirectory, treeId);
		await this.assertObjectsComplete(gitDirectory, treeId, entries);
		return {
			treeId,
			coverage,
			...ignoredPresentProof(coverage, ignoredPresentPaths),
			objectClosure: treeObjectClosure(treeId, entries),
		};
	}

	private async captureIgnoredPresentPaths(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: readonly string[],
	): Promise<string[]> {
		if (inclusions === null) {
			return [];
		}
		const pathspecs = inclusions.length === 0 ? ["."] : inclusions.map(literalPathspec);
		for (const excluded of exclusions) {
			pathspecs.push(excludeLiteralPathspec(excluded));
		}
		const output = await this.runGitBytes([
			...(gitBacked ? ["-c", "core.fsmonitor=false"] : []),
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			...pathspecs,
		], { cwd, env: gitBacked ? sourceGitEnvironment() : environment });
		const result = new Set<string>();
		for (const relativePath of parseNulPaths(output)) {
			if (
				exclusions.some((excluded) => isPathAtOrBelow(excluded, relativePath)) ||
				exactExclusions.includes(relativePath)
			) {
				continue;
			}
			await assertNoSymlinkEscape(cwd, relativePath);
			const metadata = await lstat(join(cwd, ...relativePath.split("/"))).catch((error) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (metadata === null) {
				continue;
			}
			if (!metadata.isFile() && !metadata.isSymbolicLink()) {
				throw new SnapshotStoreError("capture_failed", `ignored-present proof 只接受叶子路径：${relativePath}`);
			}
			if (result.has(relativePath)) {
				throw new SnapshotStoreError("capture_failed", `ignored-present proof 包含重复路径：${relativePath}`);
			}
			result.add(relativePath);
		}
		return [...result].sort(comparePaths);
	}

	private async stageWorktree(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: readonly string[],
	): Promise<void> {
		const leaves = await this.collectVisibleLeaves(
			cwd,
			environment,
			gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
		);
		const objectIds = new Map<string, string>();
		const hashBatches = hashPathBatches(leaves.filter((leaf) => leaf.kind === "file"));
		const hashedBatches = await mapConcurrentOrdered(hashBatches, HASH_BATCH_CONCURRENCY, async (batch) => {
			await mapConcurrentOrdered(batch, FILE_SYSTEM_INSPECTION_CONCURRENCY, (leaf) =>
				this.assertVisibleLeafUnchanged(cwd, leaf));
			const output = await this.runGit([
				"hash-object",
				"-w",
				"--no-filters",
				"--",
				...batch.map((leaf) => leaf.relativePath),
			], { cwd, env: environment });
			const hashes = parseObjectIdLines(output, batch.length);
			await mapConcurrentOrdered(batch, FILE_SYSTEM_INSPECTION_CONCURRENCY, (leaf) =>
				this.assertVisibleLeafUnchanged(cwd, leaf));
			return batch.map((leaf, index) => [leaf.relativePath, hashes[index]!] as const);
		});
		for (const batch of hashedBatches) {
			for (const [relativePath, objectId] of batch) objectIds.set(relativePath, objectId);
		}
		for (const leaf of leaves) {
			if (leaf.kind !== "symlink") continue;
			await this.assertVisibleLeafUnchanged(cwd, leaf);
			const linkText = await readlink(join(cwd, ...leaf.relativePath.split("/")), { encoding: "buffer" });
			decodeUtf8(linkText, "symlink target 不是可无损表示的 UTF-8");
			const objectId = (await this.runGit(["hash-object", "-w", "--stdin"], {
				cwd,
				env: environment,
				stdin: linkText,
			})).trim();
			if (!isObjectId(objectId)) {
				throw new SnapshotStoreError("capture_failed", `文件对象 materialize 失败：${leaf.relativePath}`);
			}
			await this.assertVisibleLeafUnchanged(cwd, leaf);
			objectIds.set(leaf.relativePath, objectId);
		}
		for (const indexInput of indexInfoBatches(leaves, objectIds)) {
			await this.runGit(["update-index", "-z", "--index-info"], {
				cwd,
				env: environment,
				stdin: indexInput,
			});
		}
	}

	private async assertVisibleLeafUnchanged(cwd: string, leaf: VisibleLeaf): Promise<void> {
		await assertNoSymlinkEscape(cwd, leaf.relativePath);
		const metadata = await lstat(join(cwd, ...leaf.relativePath.split("/"))).catch((error) => {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		});
		if (metadata === null || visibleLeafFingerprint(metadata) !== leaf.fingerprint) {
			throw new SnapshotStoreError("capture_failed", `捕获期间工作区叶子已变化：${leaf.relativePath}`);
		}
	}

	private async queryVisibleLeafPaths(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: readonly string[],
		excludeDeleted = false,
	): Promise<string[]> {
		if (inclusions === null) return [];
		const pathspecs = inclusions.length === 0 ? ["."] : inclusions.map(literalPathspec);
		for (const excluded of exclusions) pathspecs.push(excludeLiteralPathspec(excluded));
		const queryEnvironment = gitBacked ? sourceGitEnvironment() : environment;
		const [output, deletedOutput] = await Promise.all([
			this.runGitBytes([
				...(gitBacked ? ["-c", "core.fsmonitor=false"] : []),
				"ls-files",
				...(gitBacked ? ["--cached"] : []),
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				...pathspecs,
			], { cwd, env: queryEnvironment }),
			gitBacked && excludeDeleted
				? this.runGitBytes([
					"-c",
					"core.fsmonitor=false",
					"ls-files",
					"--deleted",
					"-z",
					"--",
					...pathspecs,
				], { cwd, env: queryEnvironment })
				: Promise.resolve(new Uint8Array()),
		]);
		const deletedPaths = new Set(parseNulPaths(deletedOutput));
		return parseNulPaths(output).filter((relativePath) =>
			!deletedPaths.has(relativePath) &&
			!exclusions.some((excluded) => isPathAtOrBelow(excluded, relativePath)) &&
			!exactExclusions.includes(relativePath));
	}

	private async collectVisibleLeaves(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: readonly string[],
	): Promise<VisibleLeaf[]> {
		const paths = await this.queryVisibleLeafPaths(
			cwd,
			environment,
			gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
		);
		const leaves = await mapConcurrentOrdered(paths, FILE_SYSTEM_INSPECTION_CONCURRENCY, async (relativePath) => {
			relativeSafePath(cwd, relativePath);
			await assertNoSymlinkEscape(cwd, relativePath);
			const metadata = await lstat(join(cwd, ...relativePath.split("/"))).catch((error) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (metadata === null) return null;
			if (metadata.isSymbolicLink()) {
				return {
					relativePath,
					kind: "symlink" as const,
					mode: 0o120000,
					fingerprint: visibleLeafFingerprint(metadata),
				};
			}
			if (metadata.isFile()) {
				return {
					relativePath,
					kind: "file" as const,
					mode: (metadata.mode & 0o111) === 0 ? 0o100644 : 0o100755,
					fingerprint: visibleLeafFingerprint(metadata),
				};
			}
			throw new SnapshotStoreError("capture_failed", `不支持的工作区文件类型：${relativePath}`);
		});
		return leaves.filter((leaf): leaf is VisibleLeaf => leaf !== null);
	}

	private async validateIgnoreQuery(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
	): Promise<void> {
		try {
			await this.runGit([
				...(gitBacked ? ["-c", "core.fsmonitor=false"] : []),
				"check-ignore",
				"--quiet",
				"--no-index",
				"--",
				".gitignore",
			], { cwd, env: gitBacked ? sourceGitEnvironment() : environment });
		} catch (error) {
			if (gitExitCode(error) !== 1) {
				throw error;
			}
		}
	}

	private async ensurePrivateRepository(gitDirectory: string): Promise<void> {
		try {
			const metadata = await lstat(join(gitDirectory, "objects"));
			if (metadata.isDirectory()) {
				await this.configurePrivateRepository(gitDirectory);
				return;
			}
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
		await mkdir(dirname(gitDirectory), { recursive: true });
		await this.runGit(["init", "--bare", "--quiet", gitDirectory], { env: cleanGitEnvironment() });
		await this.configurePrivateRepository(gitDirectory);
	}

	private async configurePrivateRepository(gitDirectory: string): Promise<void> {
		const environment = cleanGitEnvironment();
		await this.runGit(["--git-dir", gitDirectory, "config", "gc.auto", "0"], { env: environment });
		await this.runGit(["--git-dir", gitDirectory, "config", "maintenance.auto", "false"], { env: environment });
	}

	private async assertNoAlternates(gitDirectory: string): Promise<void> {
		try {
			await lstat(join(gitDirectory, "objects", "info", "alternates"));
			throw new SnapshotStoreError("object_missing", "私有 Git object database 不能使用 alternates");
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
	}

	private async readTreeEntries(
		gitDirectory: string,
		treeId: string,
		rootScopePaths?: readonly string[],
	): Promise<CapturedTreeEntry[]> {
		const scope = rootScopePaths === undefined
			? undefined
			: [...new Set(rootScopePaths.map((path) => relativeSafePath("/", path)))].sort(comparePaths);
		const key = `${gitDirectory}\0${treeId}\0${scope === undefined ? "*" : checksum(canonicalJson(scope))}`;
		const cached = this.treeEntriesCache.get(key);
		if (cached !== undefined) return cached;
		const pending = this.runPrivateGitBytes(gitDirectory, [
			"ls-tree",
			"-r",
			"-l",
			"-z",
			treeId,
			...(scope === undefined ? [] : ["--", ...scope.map(literalPathspec)]),
		]).then((output) => {
			const entries = parseTreeEntries(output);
			for (const entry of entries) {
				const membershipKey = treeBlobMembershipKey(gitDirectory, treeId, entry.relativePath);
				this.treeBlobMembership.delete(membershipKey);
				this.treeBlobMembership.set(membershipKey, entry.objectId);
			}
			while (this.treeBlobMembership.size > TREE_BLOB_MEMBERSHIP_LIMIT) {
				const oldest = this.treeBlobMembership.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				this.treeBlobMembership.delete(oldest);
			}
			return entries;
		});
		this.treeEntriesCache.set(key, pending);
		while (this.treeEntriesCache.size > TREE_CACHE_LIMIT) {
			const oldest = this.treeEntriesCache.keys().next().value as string | undefined;
			if (oldest === undefined || oldest === key) break;
			this.treeEntriesCache.delete(oldest);
		}
		try {
			return await pending;
		} catch (error) {
			if (this.treeEntriesCache.get(key) === pending) this.treeEntriesCache.delete(key);
			throw error;
		}
	}

	private async assertObjectsComplete(
		gitDirectory: string,
		treeId: string,
		entries: readonly CapturedTreeEntry[],
	): Promise<void> {
		const expected = [
			{ objectId: treeId, type: "tree" },
			...[...new Set(entries.map((entry) => entry.objectId))].map((objectId) => ({ objectId, type: "blob" })),
		];
		const output = await this.runGit(["cat-file", "--batch-check"], {
			env: privateObjectEnvironment(gitDirectory),
			stdin: `${expected.map((object) => object.objectId).join("\n")}\n`,
		});
		const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
		if (lines.length !== expected.length) throw new Error("Git object batch-check 输出数量不匹配");
		for (let index = 0; index < expected.length; index += 1) {
			const object = expected[index]!;
			const match = lines[index]!.match(/^([0-9a-f]{40,64}) (blob|tree) ([0-9]+)$/);
			if (
				match === null ||
				match[1] !== object.objectId ||
				match[2] !== object.type ||
				!Number.isSafeInteger(Number(match[3]))
			) {
				throw new Error(`Git object batch-check 校验失败：${object.objectId}`);
			}
		}
	}

	private async preloadBlobBytes(
		gitDirectory: string,
		entries: readonly CapturedTreeEntry[],
	): Promise<void> {
		const unique = new Map<string, CapturedTreeEntry>();
		for (const entry of entries) {
			if (!this.blobCache.has(blobCacheKey(gitDirectory, entry.objectId))) unique.set(entry.objectId, entry);
		}
		for (const batch of blobReadBatches([...unique.values()])) {
			const loaded = parseBatchBlobOutput(
				await this.runGitBytes(["cat-file", "--batch"], {
					env: privateObjectEnvironment(gitDirectory),
					stdin: `${batch.map((entry) => entry.objectId).join("\n")}\n`,
				}),
				batch,
			);
			for (const [objectId, bytes] of loaded) this.rememberBlobBytes(gitDirectory, objectId, bytes);
		}
	}

	private async readBlobText(gitDirectory: string, objectId: string): Promise<string> {
		return decodeUtf8(
			await this.readBlobBytes(gitDirectory, objectId),
			"symlink target 不是可无损表示的 UTF-8",
		);
	}

	private async readBlobBytes(gitDirectory: string, objectId: string): Promise<Uint8Array> {
		const key = blobCacheKey(gitDirectory, objectId);
		const cached = this.blobCache.get(key);
		if (cached !== undefined) {
			this.blobCache.delete(key);
			this.blobCache.set(key, cached);
			return cached.promise;
		}
		const entry: CachedBlob = {
			promise: this.runPrivateGitBytes(gitDirectory, ["cat-file", "blob", objectId]),
			size: 0,
		};
		this.blobCache.set(key, entry);
		try {
			const bytes = await entry.promise;
			this.finishBlobCacheEntry(key, entry, bytes.byteLength);
			return bytes;
		} catch (error) {
			if (this.blobCache.get(key) === entry) this.blobCache.delete(key);
			throw error;
		}
	}

	private rememberBlobBytes(gitDirectory: string, objectId: string, bytes: Uint8Array): void {
		const key = blobCacheKey(gitDirectory, objectId);
		if (this.blobCache.has(key) || bytes.byteLength > BLOB_CACHE_MAX_BYTES) return;
		const entry: CachedBlob = { promise: Promise.resolve(bytes), size: 0 };
		this.blobCache.set(key, entry);
		this.finishBlobCacheEntry(key, entry, bytes.byteLength);
	}

	private finishBlobCacheEntry(key: string, entry: CachedBlob, size: number): void {
		if (this.blobCache.get(key) !== entry) return;
		if (size > BLOB_CACHE_MAX_BYTES) {
			this.blobCache.delete(key);
			return;
		}
		entry.size = size;
		this.blobCacheBytes += size;
		while (this.blobCacheBytes > BLOB_CACHE_MAX_BYTES) {
			const oldestKey = this.blobCache.keys().next().value as string | undefined;
			if (oldestKey === undefined) break;
			const oldest = this.blobCache.get(oldestKey)!;
			this.blobCache.delete(oldestKey);
			this.blobCacheBytes -= oldest.size;
		}
	}

	private runPrivateGit(gitDirectory: string, args: readonly string[]): Promise<string> {
		return this.runGit(args, { env: privateObjectEnvironment(gitDirectory) });
	}

	private runPrivateGitBytes(gitDirectory: string, args: readonly string[]): Promise<Uint8Array> {
		return this.runGitBytes(args, { env: privateObjectEnvironment(gitDirectory) });
	}

	private async runGit(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
		const result = await this.git.run(args, options);
		if (result.killed) {
			throw new SnapshotStoreError("capture_failed", "Git 命令未正常结束");
		}
		return result.stdout;
	}

	private async runGitBytes(args: readonly string[], options: GitRunOptions = {}): Promise<Uint8Array> {
		const result = await this.git.run(args, options);
		if (result.killed) {
			throw new SnapshotStoreError("capture_failed", "Git 命令未正常结束");
		}
		return result.stdoutBytes;
	}

	private async assertTopology(expected: RootTopology, message: string): Promise<void> {
		const actual = await this.discovery.discover(expected.workspaceIdentity);
		const rootKindsMatch = actual.roots.length === expected.roots.length && actual.roots.every((root, index) => {
			const expectedRoot = expected.roots[index];
			return expectedRoot !== undefined &&
				root.relativeRoot === expectedRoot.relativeRoot &&
				root.gitBacked === expectedRoot.gitBacked;
		});
		if (
			actual.workspaceIdentity !== expected.workspaceIdentity ||
			actual.fingerprint !== expected.fingerprint ||
			!rootKindsMatch
		) {
			throw new SnapshotStoreError("capture_failed", message);
		}
	}

	private async assertPrivateStore(workspaceIdentity: string): Promise<void> {
		const targets = [this.storeRoot, this.storesRoot];
		if (targets.some((target) => isWithin(workspaceIdentity, target))) {
			throw new SnapshotStoreError("capture_failed", "私有 store 不能位于 workspace 内");
		}
		const prospectiveTargets = await Promise.all(targets.map(prospectiveCanonicalPath));
		if (prospectiveTargets.some((target) => isWithin(workspaceIdentity, target))) {
			throw new SnapshotStoreError("capture_failed", "私有 store 不能位于 workspace 内");
		}

		await mkdir(this.storesRoot, { recursive: true });
		const canonicalTargets = await Promise.all(targets.map((target) => realpath(target)));
		if (canonicalTargets.some((target) => isWithin(workspaceIdentity, target))) {
			throw new SnapshotStoreError("capture_failed", "私有 store 不能位于 workspace 内");
		}
	}

	private storeDirectory(topology: RootTopology): string {
		const outer = topology.roots.find((root) => root.relativeRoot === ".");
		if (outer === undefined) {
			throw new SnapshotStoreError("capture_failed", "topology 缺少 workspace root");
		}
		const storeId = checksum(canonicalJson({
			schemaVersion: SCHEMA_VERSION,
			workspaceIdentity: topology.workspaceIdentity,
			sourceIdentity: outer.sourceIdentity,
		}));
		return join(this.storesRoot, storeId);
	}

	private rootGitDirectory(storeDirectory: string, root: RootTopologyIdentity): string {
		return join(storeDirectory, "roots", rootStoreId(root), "git");
	}

	private async findManifestPath(id: ManifestId): Promise<string> {
		assertManifestId(id);
		const known = this.manifestLocations.get(id);
		if (known !== undefined) {
			return known;
		}
		let stores;
		try {
			stores = await readdir(this.storesRoot, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				throw new SnapshotStoreError("manifest_not_found", "manifest 不存在");
			}
			throw error;
		}
		for (const store of stores) {
			if (!store.isDirectory() || store.isSymbolicLink()) {
				continue;
			}
			const candidate = join(this.storesRoot, store.name, "manifests", `${id}${MANIFEST_SUFFIX}`);
			try {
				const metadata = await lstat(candidate);
				if (metadata.isFile() && !metadata.isSymbolicLink()) {
					this.manifestLocations.set(id, candidate);
					return candidate;
				}
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) {
					throw error;
				}
			}
		}
		throw new SnapshotStoreError("manifest_not_found", "manifest 不存在");
	}

	private async touchStore(storeDirectory: string): Promise<void> {
		await writeJsonAtomic(join(storeDirectory, GC_METADATA_FILE), {
			schemaVersion: SCHEMA_VERSION,
			lastUsedAt: this.clock(),
		} satisfies StoreGcRecord);
	}
}

function captureCoverage(workspaceIdentity: string, scope: readonly string[] | undefined): string {
	if (scope === undefined) {
		return COMPLETE_COVERAGE;
	}
	const paths = [...new Set(scope.map((path) => relativeSafePath(workspaceIdentity, path)))].sort(comparePaths);
	if (paths.includes(".")) {
		return COMPLETE_COVERAGE;
	}
	return `paths:${checksum(canonicalJson(paths))}`;
}

function captureExclusions(
	workspaceIdentity: string,
	excludePaths: readonly string[] | undefined,
): string[] {
	if (excludePaths === undefined) {
		return [];
	}
	const result = new Set<string>();
	for (const path of excludePaths) {
		const safe = relativeSafePath(workspaceIdentity, path);
		if (safe === "." || safe.split("/").some((part) => part.toLowerCase() === ".git")) {
			throw new SnapshotStoreError("capture_failed", `artifact exclusion 路径无效：${path}`);
		}
		result.add(safe);
	}
	return [...result].sort(comparePaths);
}

function ownedArtifactExclusions(
	roots: readonly DiscoveryRoot[],
	rootPath: string,
	exclusions: readonly string[],
): string[] {
	const result: string[] = [];
	for (const exclusion of exclusions) {
		const owner = roots
			.filter((candidate) => (
				candidate.relativeRoot === "." ||
				exclusion === candidate.relativeRoot ||
				isStrictRootAncestor(candidate.relativeRoot, exclusion)
			))
			.sort((left, right) => right.relativeRoot.length - left.relativeRoot.length)[0];
		if (owner?.relativeRoot !== rootPath || exclusion === rootPath) {
			continue;
		}
		result.push(rootRelativePath(rootPath, exclusion));
	}
	return result;
}

function rootRelativeScope(rootPath: string, scope: readonly string[] | undefined): string[] | undefined {
	const inclusions = rootScopePathspecs(rootPath, scope);
	if (inclusions === null) return [];
	return inclusions.length === 0 ? undefined : inclusions;
}

function rootScopePathspecs(rootPath: string, scope: readonly string[] | undefined): string[] | null {
	if (scope === undefined) return [];
	if (scope.length === 0) return null;
	const result = new Set<string>();
	for (const path of scope) {
		if (path === "." || path === rootPath || isStrictRootAncestor(path, rootPath)) {
			return [];
		}
		if (isStrictRootAncestor(rootPath, path)) {
			result.add(rootRelativePath(rootPath, path));
		}
	}
	return result.size === 0 ? null : [...result].sort(comparePaths);
}

function ownedRootInclusions(
	inclusions: readonly string[] | null,
	exclusions: readonly string[],
): string[] | null {
	if (inclusions === null || inclusions.length === 0) {
		return inclusions === null ? null : [];
	}
	const owned = inclusions.filter(
		(path) => !exclusions.some((excluded) => isPathAtOrBelow(excluded, path)),
	);
	return owned.length === 0 ? null : owned;
}

function rootCaptureCoverage(rootPath: string, scope: readonly string[] | undefined): string {
	return rootCoverageFromInclusions(rootScopePathspecs(rootPath, scope));
}

function rootCoverageFromInclusions(inclusions: readonly string[] | null): string {
	if (inclusions === null) {
		return "none";
	}
	if (inclusions.length === 0) {
		return COMPLETE_COVERAGE;
	}
	return `paths:${checksum(canonicalJson([...inclusions].sort(comparePaths)))}`;
}

function treeObjectClosure(treeId: string, entries: readonly CapturedTreeEntry[]): string {
	return checksum(canonicalJson({
		treeId,
		entries: entries.map((entry) => ({
			mode: entry.mode,
			objectId: entry.objectId,
			relativePath: entry.relativePath,
			size: entry.size,
		})),
	}));
}

function snapshotRoot(
	root: DiscoveryRoot,
	capture: {
		readonly treeId: string | null;
		readonly coverage: string;
		readonly ignorePolicy: string;
		readonly ignoredPresentPaths: readonly string[];
		readonly ignoreClosure: string;
		readonly objectClosure: string;
	},
): SnapshotRoot {
	return {
		relativeRoot: root.relativeRoot,
		parentRoot: root.parentRoot,
		state: root.state,
		sourceIdentity: root.sourceIdentity,
		privateRepositoryId: root.privateRepositoryId,
		treeId: capture.treeId,
		coverage: capture.coverage,
		ignorePolicy: capture.ignorePolicy,
		ignoredPresentPaths: capture.ignoredPresentPaths,
		ignoreClosure: capture.ignoreClosure,
		objectClosure: capture.objectClosure,
		...(root.gitlinkOid === undefined ? {} : { gitlinkOid: root.gitlinkOid }),
	};
}

function ignoredPresentProof(coverage: string, ignoredPresentPaths: readonly string[]) {
	const proof = {
		coverage,
		ignorePolicy: IGNORE_POLICY,
		ignoredPresentPaths,
	};
	return {
		ignorePolicy: proof.ignorePolicy,
		ignoredPresentPaths,
		ignoreClosure: ignoredPresentClosure(proof),
	};
}

function inactiveRootClosure(root: Pick<RootTopologyIdentity, "relativeRoot" | "state">): string {
	return checksum(canonicalJson({
		relativeRoot: root.relativeRoot,
		state: root.state,
		treeId: null,
	}));
}

function workspaceRootPath(workspaceIdentity: string, rootPath: string): string {
	const safe = relativeSafePath(workspaceIdentity, rootPath);
	return safe === "." ? workspaceIdentity : join(workspaceIdentity, ...safe.split("/"));
}

function workspaceRelativePath(rootPath: string, relativePath: string): string {
	return rootPath === "." ? relativePath : `${rootPath}/${relativePath}`;
}

function rootStoreId(root: RootTopologyIdentity): string {
	return checksum(canonicalJson({
		relativeRoot: root.relativeRoot,
		sourceIdentity: root.sourceIdentity,
		privateRepositoryId: root.privateRepositoryId,
	}));
}

function privateGitEnvironment(
	gitDirectory: string,
	workTree: string,
	indexFile: string,
): Readonly<Record<string, string | undefined>> {
	return {
		...privateObjectEnvironment(gitDirectory),
		GIT_WORK_TREE: workTree,
		GIT_INDEX_FILE: indexFile,
		GIT_COMMON_DIR: undefined,
		GIT_OPTIONAL_LOCKS: "0",
	};
}

function privateObjectEnvironment(gitDirectory: string): Readonly<Record<string, string | undefined>> {
	return {
		GIT_DIR: gitDirectory,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_OBJECT_DIRECTORY: undefined,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
		GIT_NAMESPACE: undefined,
		GIT_TERMINAL_PROMPT: "0",
		...isolatedGitConfiguration(),
	};
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
		...isolatedGitConfiguration(),
	};
}

function sourceGitEnvironment(): Readonly<Record<string, string | undefined>> {
	return {
		GIT_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_OBJECT_DIRECTORY: undefined,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
		GIT_NAMESPACE: undefined,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: undefined,
		GIT_CONFIG_PARAMETERS: undefined,
		GIT_CONFIG_SYSTEM: undefined,
		GIT_CONFIG_GLOBAL: undefined,
		GIT_CONFIG_NOSYSTEM: undefined,
		GIT_ATTR_NOSYSTEM: undefined,
	};
}

function isolatedGitConfiguration(): Readonly<Record<string, string | undefined>> {
	return {
		GIT_CONFIG_COUNT: undefined,
		GIT_CONFIG_PARAMETERS: undefined,
		GIT_CONFIG_SYSTEM: undefined,
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
	};
}

function treeBlobMembershipKey(gitDirectory: string, treeId: string, relativePath: string): string {
	return `${gitDirectory}\0${treeId}\0${relativePath}`;
}

function blobCacheKey(gitDirectory: string, objectId: string): string {
	return `${gitDirectory}\0${objectId}`;
}

function blobReadBatches(entries: readonly CapturedTreeEntry[]): CapturedTreeEntry[][] {
	const result: CapturedTreeEntry[][] = [];
	let batch: CapturedTreeEntry[] = [];
	let bytes = 0;
	for (const entry of entries) {
		if (
			batch.length > 0 &&
			(batch.length >= BLOB_BATCH_MAX_ENTRIES || bytes + entry.size > BLOB_BATCH_MAX_BYTES)
		) {
			result.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(entry);
		bytes += entry.size;
	}
	if (batch.length > 0) result.push(batch);
	return result;
}

function parseBatchBlobOutput(
	output: Uint8Array,
	expected: readonly CapturedTreeEntry[],
): Map<string, Uint8Array> {
	const result = new Map<string, Uint8Array>();
	let offset = 0;
	for (const entry of expected) {
		const lineEnd = output.indexOf(0x0a, offset);
		if (lineEnd < 0) throw new SnapshotStoreError("object_missing", "Git blob batch header 不完整");
		const header = decodeUtf8(output.subarray(offset, lineEnd));
		const match = header.match(/^([0-9a-f]{40,64}) blob ([0-9]+)$/);
		if (match === null || match[1] !== entry.objectId || Number(match[2]) !== entry.size) {
			throw new SnapshotStoreError("object_missing", `Git blob batch header 无效：${entry.objectId}`);
		}
		const contentStart = lineEnd + 1;
		const contentEnd = contentStart + entry.size;
		if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
			throw new SnapshotStoreError("object_missing", `Git blob batch 内容不完整：${entry.objectId}`);
		}
		result.set(entry.objectId, output.slice(contentStart, contentEnd));
		offset = contentEnd + 1;
	}
	if (offset !== output.length) {
		throw new SnapshotStoreError("object_missing", "Git blob batch 输出包含多余内容");
	}
	return result;
}

function indexInfoBatches(
	leaves: readonly VisibleLeaf[],
	objectIds: ReadonlyMap<string, string>,
): Buffer[] {
	const result: Buffer[] = [];
	let records: string[] = [];
	let bytes = 0;
	for (const leaf of leaves) {
		const objectId = objectIds.get(leaf.relativePath);
		if (objectId === undefined) {
			throw new SnapshotStoreError("capture_failed", `文件对象 materialize 结果缺失：${leaf.relativePath}`);
		}
		const record = `${leaf.mode.toString(8)} ${objectId}\t${leaf.relativePath}\0`;
		const recordBytes = Buffer.byteLength(record, "utf8");
		if (
			records.length > 0 &&
			(records.length >= INDEX_BATCH_MAX_ENTRIES || bytes + recordBytes > INDEX_BATCH_MAX_BYTES)
		) {
			result.push(Buffer.from(records.join(""), "utf8"));
			records = [];
			bytes = 0;
		}
		records.push(record);
		bytes += recordBytes;
	}
	if (records.length > 0) result.push(Buffer.from(records.join(""), "utf8"));
	return result;
}

function visibleLeafFingerprint(metadata: Stats): string {
	return checksum(canonicalJson({
		kind: metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "other",
		dev: metadata.dev,
		ino: metadata.ino,
		mode: metadata.mode,
		size: metadata.size,
		mtimeMs: metadata.mtimeMs,
		ctimeMs: metadata.ctimeMs,
	}));
}

async function mapConcurrentOrdered<T, R>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T) => Promise<R>,
): Promise<R[]> {
	const result = new Array<R>(values.length);
	let nextIndex = 0;
	let failed = false;
	let failure: unknown;
	async function worker(): Promise<void> {
		while (!failed && nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				result[index] = await operation(values[index]!);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
	if (failed) throw failure;
	return result;
}

function hashPathBatches(leaves: readonly VisibleLeaf[]): VisibleLeaf[][] {
	const result: VisibleLeaf[][] = [];
	let current: VisibleLeaf[] = [];
	let argumentBytes = 0;
	for (const leaf of leaves) {
		const leafBytes = Buffer.byteLength(leaf.relativePath, "utf8") + 1;
		if (
			current.length > 0 &&
			(current.length >= HASH_BATCH_MAX_PATHS || argumentBytes + leafBytes > HASH_BATCH_MAX_ARGUMENT_BYTES)
		) {
			result.push(current);
			current = [];
			argumentBytes = 0;
		}
		current.push(leaf);
		argumentBytes += leafBytes;
	}
	if (current.length > 0) result.push(current);
	return result;
}

function parseObjectIdLines(output: string, expectedCount: number): string[] {
	const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
	if (lines.length !== expectedCount || lines.some((line) => !isObjectId(line))) {
		throw new SnapshotStoreError("capture_failed", "git hash-object 批量输出无效");
	}
	return lines;
}

function parseTreeEntries(output: Uint8Array): CapturedTreeEntry[] {
	const entries: CapturedTreeEntry[] = [];
	for (const record of splitNulRecords(output)) {
		const tab = record.indexOf(0x09);
		if (tab < 0) {
			throw new SnapshotStoreError("object_missing", "git ls-tree 输出格式无效");
		}
		const [modeText, type, objectId, sizeText] = decodeUtf8(record.subarray(0, tab)).split(/\s+/);
		const mode = Number.parseInt(modeText, 8);
		const size = Number.parseInt(sizeText, 10);
		if (type !== "blob" || !Number.isInteger(mode) || !isObjectId(objectId) || !Number.isInteger(size) || size < 0) {
			throw new SnapshotStoreError("object_missing", "root tree 包含不支持或损坏的对象");
		}
		const relativePath = decodeUtf8(record.subarray(tab + 1));
		relativeSafePath("/", relativePath);
		entries.push({ mode, objectId, size, relativePath });
	}
	return entries.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
}

function parseNulPaths(output: Uint8Array): string[] {
	return splitNulRecords(output).map((record) => {
		const path = decodeUtf8(record);
		relativeSafePath("/", path);
		return path;
	});
}

function splitNulRecords(output: Uint8Array): Uint8Array[] {
	if (output.length === 0) {
		return [];
	}
	const records: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < output.length; index += 1) {
		if (output[index] !== 0) {
			continue;
		}
		if (index === start) {
			throw new SnapshotStoreError("capture_failed", "Git NUL 路径输出包含空记录");
		}
		records.push(output.slice(start, index));
		start = index + 1;
	}
	if (start !== output.length) {
		throw new SnapshotStoreError("capture_failed", "Git NUL 路径输出不完整");
	}
	return records;
}

function decodeUtf8(bytes: Uint8Array, message = "工作区路径不是可无损表示的 UTF-8"): string {
	const buffer = Buffer.from(bytes);
	const value = buffer.toString("utf8");
	if (!Buffer.from(value, "utf8").equals(buffer)) {
		throw new SnapshotStoreError("capture_failed", message);
	}
	return value;
}

async function readPin(path: string, expectedManifestId: ManifestId): Promise<PinRecord | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isPinRecord(value) || value.manifestId !== expectedManifestId) {
			throw new SnapshotStoreError("invalid_pin", "pin 记录无效");
		}
		return value;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

async function hasPinnedManifest(storeDirectory: string): Promise<boolean> {
	const pinsDirectory = join(storeDirectory, "pins");
	let entries;
	try {
		entries = await readdir(pinsDirectory, { withFileTypes: true });
	} catch (error) {
		return hasErrorCode(error, "ENOENT") ? false : true;
	}
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(MANIFEST_SUFFIX)) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(await readFile(join(pinsDirectory, entry.name), "utf8"));
			if (!isPinRecord(value) || value.reasons.length > 0) {
				return true;
			}
		} catch {
			return true;
		}
	}
	return false;
}

async function readGcRecord(path: string): Promise<StoreGcRecord | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			(value as Record<string, unknown>).schemaVersion === SCHEMA_VERSION &&
			typeof (value as Record<string, unknown>).lastUsedAt === "number"
		) {
			return value as StoreGcRecord;
		}
		return null;
	} catch {
		return null;
	}
}

async function statMtime(path: string): Promise<number> {
	return (await stat(path).catch(() => null))?.mtimeMs ?? 0;
}

function isPinRecord(value: unknown): value is PinRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === SCHEMA_VERSION &&
		typeof record.manifestId === "string" &&
		Array.isArray(record.reasons) &&
		record.reasons.every((reason) => typeof reason === "string" && reason.length > 0) &&
		typeof record.updatedAt === "string"
	);
}

function assertManifestId(id: ManifestId): void {
	if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) {
		throw new SnapshotStoreError("invalid_manifest_id", "manifest ID 必须是 SHA-256");
	}
}

function assertPinReason(reason: string): void {
	if (typeof reason !== "string" || reason.trim().length === 0 || reason.includes("\0")) {
		throw new SnapshotStoreError("invalid_pin", "pin reason 不能为空");
	}
}

function rootRelativePath(parent: string, child: string): string {
	return parent === "." ? child : child.slice(parent.length + 1);
}

function literalPathspec(path: string): string {
	return `:(top,literal)${path}`;
}

function excludeLiteralPathspec(path: string): string {
	return `:(top,exclude,literal)${path}`;
}

function isPathAtOrBelow(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isStrictRootAncestor(parent: string, child: string): boolean {
	return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function isWithin(parent: string, candidate: string): boolean {
	const value = relative(parent, candidate);
	return value.length === 0 || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function prospectiveCanonicalPath(path: string): Promise<string> {
	const target = resolve(path);
	let ancestor = target;
	while (true) {
		try {
			const canonicalAncestor = await realpath(ancestor);
			return resolve(canonicalAncestor, relative(ancestor, target));
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) {
			throw new SnapshotStoreError("capture_failed", "无法解析私有 store 路径");
		}
		ancestor = parent;
	}
}

function isObjectId(value: string | undefined): value is string {
	return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function gitExitCode(error: unknown): number | null | undefined {
	if (typeof error !== "object" || error === null || !("result" in error)) {
		return undefined;
	}
	const result = error.result;
	return typeof result === "object" && result !== null && "code" in result && typeof result.code === "number"
		? result.code
		: undefined;
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
