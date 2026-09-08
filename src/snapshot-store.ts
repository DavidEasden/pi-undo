import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { fsyncDirectory, writeBytesAtomic, writeContentAddressed, writeJsonAtomic } from "./atomic-fs.ts";
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
import type { NativeMetadataEntry, NativeMetadataPort } from "./native-metadata.ts";
import { NativeMetadataInspector } from "./native-metadata.ts";
import { assertNoSymlinkEscape, assertNoSymlinkParents, pathSetsOverlap, relativeSafePath } from "./path-safety.ts";
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
const ROOT_CAPTURE_CONCURRENCY = 4;
const FILE_SYSTEM_INSPECTION_CONCURRENCY = 32;
const METADATA_BATCH_SIZE = 1_024;
const INDEX_BATCH_MAX_ENTRIES = 4_096;
const INDEX_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const BLOB_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_BATCH_MAX_ENTRIES = process.platform === "win32" ? 256 : 2_048;
const RACY_CLEAN_WINDOW_NS = 2_000_000_000n;
const LEAF_CACHE_FILE = "leaf-cache.json";

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
	readonly cacheUpdate: VisibleLeafCacheUpdate;
}

interface VisibleLeafMetadata {
	readonly kind: "file" | "symlink" | "other";
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

interface VisibleLeaf {
	readonly relativePath: string;
	readonly kind: "file" | "symlink";
	readonly mode: number;
	readonly fingerprint: string;
	readonly changedAtNs: bigint;
	readonly cacheable: boolean;
}

interface CachedVisibleLeaf extends VisibleLeaf {
	readonly objectId: string;
	readonly verifiedAtNs: bigint;
}

interface StagedWorktree {
	readonly leaves: readonly VisibleLeaf[];
	readonly objectIds: ReadonlyMap<string, string>;
	readonly verifiedAtNs: bigint;
}

interface VisibleLeafCacheUpdate {
	readonly gitDirectory: string;
	readonly staged: StagedWorktree;
	readonly inclusions: readonly string[] | null;
}

interface CachedBlob {
	readonly promise: Promise<Uint8Array>;
	size: number;
}

/** 持久化叶子缓存文件（storeDirectory/leaf-cache.json），schema 不匹配时整体忽略。 */
interface PersistedLeafCacheFile {
	readonly schemaVersion: 1;
	readonly entries: Readonly<Record<string, Readonly<Record<string, PersistedLeafCacheEntry>>>>;
}

interface PersistedLeafCacheEntry {
	readonly kind: "file" | "symlink";
	readonly mode: number;
	readonly fingerprint: string;
	readonly cacheable: boolean;
	readonly objectId: string;
	readonly changedAtNs: string;
	readonly verifiedAtNs: string;
}

export interface SnapshotStoreOptions {
	readonly storeRoot?: string;
	readonly git?: GitRunner;
	readonly discovery?: RootDiscovery;
	readonly lock?: WorkspaceLock;
	readonly clock?: () => number;
	readonly nativeMetadata?: NativeMetadataPort;
}

export interface CaptureOptions {
	readonly excludePaths?: readonly string[];
	/** 调用方刚完成 topology discovery 时跳过重复的捕获前校验。捕获后校验仍然执行。 */
	readonly topologyAlreadyValidated?: boolean;
}

export interface SnapshotBlobRequest {
	readonly rootPath: string;
	readonly blobId: string;
	readonly relativePath?: string;
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
	captureBaseline(
		topology: RootTopology,
		baseline: SnapshotManifest,
		scope?: readonly string[],
		options?: CaptureOptions,
	): Promise<SnapshotManifest>;
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
	private readonly nativeMetadata: NativeMetadataPort;
	private readonly manifestLocations = new Map<string, string>();
	// Tree 与 blob 都由 object ID 内容寻址；缓存只复用已从私有 ODB 读取的不可变内容。
	private readonly treeEntriesCache = new Map<string, Promise<CapturedTreeEntry[]>>();
	private readonly treeBlobMembership = new Map<string, string>();
	private readonly blobCache = new Map<string, CachedBlob>();
	private readonly visibleLeafCache = new Map<string, Map<string, CachedVisibleLeaf>>();
	private readonly leafCacheDirectoriesLoaded = new Set<string>();
	private readonly configuredPrivateRepositories = new Set<string>();
	private readonly leafCacheDirtyDirectories = new Set<string>();
	private blobCacheBytes = 0;

	constructor(options: SnapshotStoreOptions = {}) {
		this.storeRoot = resolve(options.storeRoot ?? join(tmpdir(), "pi-undo-snapshot-store"));
		this.storesRoot = join(this.storeRoot, "stores");
		this.git = options.git ?? new GitRunner();
		this.discovery = options.discovery ?? new RootDiscovery(this.git);
		this.lock = options.lock ?? new WorkspaceLock();
		this.clock = options.clock ?? Date.now;
		this.nativeMetadata = options.nativeMetadata ?? new NativeMetadataInspector();
	}

	static supportsValidatedBlobBatch(store: SnapshotStore): boolean {
		return store instanceof SnapshotStore &&
			store.readBlob === SnapshotStore.prototype.readBlob &&
			store.loadManifest === SnapshotStore.prototype.loadManifest;
	}

	static async readBlobs(
		store: SnapshotStore,
		id: ManifestId,
		requests: readonly SnapshotBlobRequest[],
	): Promise<readonly Uint8Array[]> {
		if (requests.length === 0) return [];
		if (SnapshotStore.supportsValidatedBlobBatch(store)) {
			return (store as SnapshotStore).readBlobsValidated(id, requests);
		}
		const result: Uint8Array[] = [];
		for (const request of requests) {
			result.push(await store.readBlob(
				id,
				request.rootPath,
				request.blobId,
				request.relativePath,
			));
		}
		return result;
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
			if (options.topologyAlreadyValidated !== true) {
				await this.assertTopology(topology, "捕获前 topology 已变化");
			}
			const brokenRoots = brokenRootPaths(topology);
			if (brokenRoots.length > 0) {
				throw new SnapshotStoreError("capture_failed", `broken root 不能静默进入快照: ${brokenRoots.join(", ")}`);
			}

			const storeDirectory = this.storeDirectory(topology);
			// 新进程首次 capture 时从磁盘加载叶子指纹缓存，避免全量重新 hash。
			await this.loadPersistedLeafCache(storeDirectory);
			const transactionsRoot = join(storeDirectory, "transactions");
			await mkdir(transactionsRoot, { recursive: true });
			transactionDirectory = await mkdtemp(join(transactionsRoot, "capture-"));
			const activeTransactionDirectory = transactionDirectory;

			// 每个 root 使用独立私有 ODB、index 与 worktree；结果保持输入顺序，缓存仍在整个 capture
			// 持久化成功后统一发布，因此可并行缩短 nested-repository workspace 的关键路径。
			const capturedRoots = await mapConcurrentOrdered(
				topology.roots,
				ROOT_CAPTURE_CONCURRENCY,
				async (root): Promise<{ readonly root: SnapshotRoot; readonly cacheUpdate?: VisibleLeafCacheUpdate }> => {
					if (root.state !== "active") {
						const coverage = rootCaptureCoverage(root.relativeRoot, scope);
						return {
							root: snapshotRoot(root, {
								treeId: null,
								coverage,
								...ignoredPresentProof(coverage, []),
								objectClosure: inactiveRootClosure(root),
							}),
						};
					}
					const captured = await this.captureRoot(
						topology,
						root,
						activeTransactionDirectory,
						scope,
						artifactExclusions,
					);
					return {
						root: snapshotRoot(root, captured),
						cacheUpdate: captured.cacheUpdate,
					};
				},
			);
			const roots = capturedRoots.map((captured) => captured.root);
			const cacheUpdates = capturedRoots.flatMap((captured) =>
				captured.cacheUpdate === undefined ? [] : [captured.cacheUpdate]);

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
			for (const update of cacheUpdates) this.rememberVisibleLeaves(update);
			// 指纹缓存落盘：让下一个进程（新会话）的首次 capture 跳过全量内容 hash。
			await this.persistLeafCache(storeDirectory);
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

	/**
	 * 复核 warm-up 生成的 baseline；只有 topology、可见路径、文件 metadata 和 ignored proof
	 * 都能由现有证据证明未变化时，才跳过完整 capture。
	 */
	async captureBaseline(
		topology: RootTopology,
		baseline: SnapshotManifest,
		scope?: readonly string[],
		options: CaptureOptions = {},
	): Promise<SnapshotManifest> {
		await this.assertPrivateStore(topology.workspaceIdentity);
		const lockIdentity = `snapshot-store:${await prospectiveCanonicalPath(this.storesRoot)}`;
		return this.lock.withLock(lockIdentity, () => this.captureBaselineLocked(topology, baseline, scope, options));
	}

	private async captureBaselineLocked(
		topology: RootTopology,
		baseline: SnapshotManifest,
		scope: readonly string[] | undefined,
		options: CaptureOptions,
	): Promise<SnapshotManifest> {
		try {
			if (topology.fingerprint !== topologyFingerprint(topology.workspaceIdentity, topology.roots)) {
				throw new SnapshotStoreError("capture_failed", "topology fingerprint 与 roots 不匹配");
			}
			if (options.topologyAlreadyValidated !== true) {
				await this.assertTopology(topology, "捕获前 topology 已变化");
			}
			const brokenRoots = brokenRootPaths(topology);
			if (brokenRoots.length > 0) {
				throw new SnapshotStoreError("capture_failed", `broken root 不能静默进入 baseline 校验: ${brokenRoots.join(", ")}`);
			}
			if (await this.isBaselineFresh(topology, baseline, scope, options)) {
				await this.assertTopology(topology, "捕获期间 topology 已变化");
				await this.touchStore(this.storeDirectory(topology));
				return baseline;
			}
			// 已完成一次捕获前 topology 校验；完整回退仍保留捕获后的校验。
			return this.captureLocked(topology, scope, { ...options, topologyAlreadyValidated: true });
		} catch (error) {
			if (error instanceof SnapshotStoreError) {
				throw error;
			}
			throw new SnapshotStoreError("capture_failed", errorMessage(error), { cause: error });
		}
	}

	private async isBaselineFresh(
		topology: RootTopology,
		baseline: SnapshotManifest,
		scope: readonly string[] | undefined,
		options: CaptureOptions,
	): Promise<boolean> {
		try {
			assertManifest(baseline);
		} catch {
			return false;
		}
		const artifactExclusions = captureExclusions(topology.workspaceIdentity, options.excludePaths);
		if (
			baseline.workspaceIdentity !== topology.workspaceIdentity ||
			baseline.topologyFingerprint !== topology.fingerprint ||
			baseline.coverage !== captureCoverage(topology.workspaceIdentity, scope) ||
			baseline.roots.length !== topology.roots.length
		) {
			return false;
		}

		const storeDirectory = this.storeDirectory(topology);
		await this.loadPersistedLeafCache(storeDirectory);
		const transactionsRoot = join(storeDirectory, "transactions");
		await mkdir(transactionsRoot, { recursive: true });
		const transactionDirectory = await mkdtemp(join(transactionsRoot, "baseline-"));
		try {
			const baselineRoots = new Map(baseline.roots.map((root) => [root.relativeRoot, root]));
			for (const root of topology.roots) {
				const baselineRoot = baselineRoots.get(root.relativeRoot);
				if (
					baselineRoot === undefined ||
					baselineRoot.parentRoot !== root.parentRoot ||
					baselineRoot.state !== root.state ||
					baselineRoot.sourceIdentity !== root.sourceIdentity ||
					baselineRoot.privateRepositoryId !== root.privateRepositoryId ||
					(baselineRoot.gitlinkOid ?? null) !== (root.gitlinkOid ?? null) ||
					baselineRoot.coverage !== rootCaptureCoverage(root.relativeRoot, scope, topology.roots) ||
					baselineRoot.ignorePolicy !== IGNORE_POLICY
				) {
					return false;
				}
				if (root.state !== "active") {
					if (
						baselineRoot.treeId !== null ||
						baselineRoot.ignoredPresentPaths.length > 0 ||
						baselineRoot.objectClosure !== inactiveRootClosure(root)
					) {
						return false;
					}
					continue;
				}

				const treeId = baselineRoot.treeId;
				if (treeId === null) return false;
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
				const entries = await this.readTreeEntries(gitDirectory, treeId);
				await this.assertObjectsComplete(gitDirectory, treeId, entries);
				if (baselineRoot.objectClosure !== treeObjectClosure(treeId, entries)) return false;

				const leaves = await this.collectVisibleLeaves(
					absoluteRoot,
					environment,
					root.gitBacked,
					inclusions,
					exclusions,
					exactExclusions,
					transactionDirectory,
				);
				if (!samePathList(
					leaves.map((leaf) => leaf.relativePath).sort(comparePaths),
					entries.map((entry) => entry.relativePath).sort(comparePaths),
				)) {
					return false;
				}
				const cache = this.visibleLeafCache.get(gitDirectory);
				if (cache === undefined) return false;
				const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
				for (const leaf of leaves) {
					const entry = entriesByPath.get(leaf.relativePath);
					const cached = cache.get(leaf.relativePath);
					if (
						entry === undefined ||
						!leaf.cacheable ||
						cached?.cacheable !== true ||
						cached.kind !== leaf.kind ||
						cached.mode !== leaf.mode ||
						cached.fingerprint !== leaf.fingerprint ||
						cached.objectId !== entry.objectId ||
						cached.verifiedAtNs <= cached.changedAtNs + RACY_CLEAN_WINDOW_NS
					) {
						return false;
					}
				}

				const ignoredPresentPaths = await this.captureIgnoredPresentPaths(
					absoluteRoot,
					environment,
					root.gitBacked,
					inclusions,
					exclusions,
					exactExclusions,
					transactionDirectory,
				);
				if (!samePathList(ignoredPresentPaths, baselineRoot.ignoredPresentPaths)) return false;
				if (baselineRoot.ignoreClosure !== ignoredPresentClosure({
					coverage: baselineRoot.coverage,
					ignorePolicy: IGNORE_POLICY,
					ignoredPresentPaths,
				})) return false;
				// metadata 初检与最终复核之间若有变化，放弃 baseline，回退完整 capture。
				await this.assertVisibleLeavesUnchanged(absoluteRoot, leaves, transactionDirectory);
			}
			return true;
		} catch {
			// baseline 证据读取失败时不复用旧快照；完整 capture 会重新建立对象和缓存。
			return false;
		} finally {
			await rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
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
			const brokenRoots = brokenRootPaths(topology);
			if (brokenRoots.length > 0) {
				throw new SnapshotStoreError("capture_failed", `broken root 不能静默进入可见路径枚举: ${brokenRoots.join(", ")}`);
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
		return this.loadManifestFromPath(id, await this.findManifestPath(id));
	}

	private async loadManifestFromPath(id: ManifestId, manifestPath: string): Promise<SnapshotManifest> {
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
				if (pathSetsOverlap(
					root.ignoredPresentPaths,
					entries.map((entry) => entry.relativePath),
				)) {
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
		return (await this.readBlobOperation(id, [{ rootPath, blobId, relativePath }], false))[0]!;
	}

	/** 按 root 批量预取普通文件 blob；membership 与 manifest 校验仍走只读路径。 */
	async prefetchBlobs(id: ManifestId, requests: readonly SnapshotBlobRequest[]): Promise<void> {
		if (requests.length === 0) return;
		for (const request of requests) {
			relativeSafePath("/", request.rootPath);
			if (!isObjectId(request.blobId)) {
				throw new SnapshotStoreError("object_missing", "blob ID 无效");
			}
			if (request.relativePath === undefined) {
				throw new SnapshotStoreError("object_missing", "blob 预取必须提供 root-relative path");
			}
		}
		const manifestPath = await this.findManifestPath(id);
		const manifest = await this.loadManifest(id);
		const roots = new Map(manifest.roots.map((root) => [root.relativeRoot, root]));
		const storeDirectory = dirname(dirname(manifestPath));
		const byRoot = new Map<string, SnapshotBlobRequest[]>();
		for (const request of requests) {
			const grouped = byRoot.get(request.rootPath) ?? [];
			grouped.push(request);
			byRoot.set(request.rootPath, grouped);
		}
		try {
			const grouped = new Map<string, Map<string, CapturedTreeEntry>>();
			for (const [rootPath, rootRequests] of byRoot) {
				const root = roots.get(rootPath);
				if (root === undefined) {
					throw new SnapshotStoreError("root_not_found", "manifest 中不存在指定 root");
				}
				if (root.state !== "active" || root.treeId === null) {
					throw new SnapshotStoreError("object_missing", "指定 root 没有可读取的 tree");
				}
				const gitDirectory = this.rootGitDirectory(storeDirectory, root);
				const entries = await this.readTreeEntries(gitDirectory, root.treeId);
				const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
				const unique = grouped.get(gitDirectory) ?? new Map<string, CapturedTreeEntry>();
				for (const request of rootRequests) {
					const safeRelativePath = relativeSafePath("/", request.relativePath!);
					const entry = byPath.get(safeRelativePath);
					if (entry === undefined || entry.objectId !== request.blobId) {
						throw new SnapshotStoreError("object_missing", "blob 不属于指定 root tree path");
					}
					unique.set(entry.objectId, entry);
				}
				grouped.set(gitDirectory, unique);
			}
			for (const [gitDirectory, unique] of grouped) {
				await this.preloadBlobBytes(gitDirectory, [...unique.values()]);
			}
		} catch (error) {
			if (error instanceof SnapshotStoreError) throw error;
			throw new SnapshotStoreError("object_missing", "blob 无法预取", { cause: error });
		}
	}

	private readBlobsValidated(
		id: ManifestId,
		requests: readonly SnapshotBlobRequest[],
	): Promise<readonly Uint8Array[]> {
		return this.readBlobOperation(id, requests, true);
	}

	private async readBlobOperation(
		id: ManifestId,
		requests: readonly SnapshotBlobRequest[],
		revalidateManifest: boolean,
	): Promise<readonly Uint8Array[]> {
		for (const request of requests) {
			relativeSafePath("/", request.rootPath);
			if (!isObjectId(request.blobId)) {
				throw new SnapshotStoreError("object_missing", "blob ID 无效");
			}
		}
		const manifestPath = await this.findManifestPath(id);
		const manifest = revalidateManifest
			? await this.loadManifestFromPath(id, manifestPath)
			: await this.loadManifest(id);
		const roots = new Map(manifest.roots.map((root) => [root.relativeRoot, root]));
		const storeDirectory = dirname(dirname(manifestPath));
		try {
			const result: Uint8Array[] = [];
			for (const request of requests) {
				const root = roots.get(request.rootPath);
				if (root === undefined) {
					throw new SnapshotStoreError("root_not_found", "manifest 中不存在指定 root");
				}
				if (root.state !== "active" || root.treeId === null) {
					throw new SnapshotStoreError("object_missing", "指定 root 没有可读取的 tree");
				}
				const gitDirectory = this.rootGitDirectory(storeDirectory, root);
				const safeRelativePath = request.relativePath === undefined
					? undefined
					: relativeSafePath("/", request.relativePath);
				if (safeRelativePath === undefined) {
					const entries = await this.readTreeEntries(gitDirectory, root.treeId);
					if (!entries.some((entry) => entry.objectId === request.blobId)) {
						throw new SnapshotStoreError("object_missing", "blob 不属于指定 root tree");
					}
				} else {
					const membershipKey = treeBlobMembershipKey(gitDirectory, root.treeId, safeRelativePath);
					let ownedBlobId = this.treeBlobMembership.get(membershipKey);
					if (ownedBlobId === undefined) {
						await this.readTreeEntries(gitDirectory, root.treeId, [safeRelativePath]);
						ownedBlobId = this.treeBlobMembership.get(membershipKey);
					}
					if (ownedBlobId !== request.blobId) {
						throw new SnapshotStoreError("object_missing", "blob 不属于指定 root tree path");
					}
				}
				result.push(new Uint8Array(await this.readBlobBytes(gitDirectory, request.blobId)));
			}
			if (revalidateManifest) await this.loadManifestFromPath(id, manifestPath);
			return result;
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
				for (const gitDirectory of this.visibleLeafCache.keys()) {
					if (gitDirectory.startsWith(`${storeDirectory}${sep}`)) this.visibleLeafCache.delete(gitDirectory);
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
		const staged = await this.stageWorktree(
			absoluteRoot,
			environment,
			root.gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
			this.visibleLeafCache.get(gitDirectory),
			transactionDirectory,
		);
		const coverage = rootCoverageFromInclusions(inclusions);
		const ignoredPresentPaths = await this.captureIgnoredPresentPaths(
			absoluteRoot,
			environment,
			root.gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
			transactionDirectory,
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
			cacheUpdate: { gitDirectory, staged, inclusions },
		};
	}

	private async captureIgnoredPresentPaths(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: ReadonlySet<string>,
		requestDirectory: string,
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
		const candidates: string[] = [];
		const seen = new Set<string>();
		for (const relativePath of parseNulPaths(output)) {
			if (
				exclusions.some((excluded) => isPathAtOrBelow(excluded, relativePath)) ||
				exactExclusions.has(relativePath)
			) {
				continue;
			}
			if (seen.has(relativePath)) {
				throw new SnapshotStoreError("capture_failed", `ignored-present proof 包含重复路径：${relativePath}`);
			}
			seen.add(relativePath);
			candidates.push(relativePath);
		}
		// ignored build/vendor trees 常含数万叶子；复用同一批量 metadata 协议，避免逐路径重复
		// 遍历父目录。Native 与 fallback 都在叶子扫描前后复核共享父目录。
		const nativeEntries = await this.inspectNativeMetadataBatches(cwd, candidates, requestDirectory);
		const kinds = nativeEntries === undefined
			? await this.collectIgnoredPresentKindsFallback(cwd, candidates)
			: nativeEntries.map((entry) => entry.kind);
		const result: string[] = [];
		for (let index = 0; index < candidates.length; index += 1) {
			const relativePath = candidates[index]!;
			const kind = kinds[index]!;
			if (kind === "absent") continue;
			if (kind !== "file" && kind !== "symlink") {
				throw new SnapshotStoreError("capture_failed", `ignored-present proof 只接受叶子路径：${relativePath}`);
			}
			result.push(relativePath);
		}
		return result.sort(comparePaths);
	}

	private async inspectNativeMetadataBatches(
		cwd: string,
		paths: readonly string[],
		requestDirectory: string,
	): Promise<readonly NativeMetadataEntry[] | undefined> {
		// 空路径不得触发 native inspect；首批 unsupported 才整体回退，中途变化必须 fail closed。
		if (paths.length === 0) return [];
		const result: NativeMetadataEntry[] = [];
		for (let offset = 0; offset < paths.length; offset += METADATA_BATCH_SIZE) {
			const batch = paths.slice(offset, offset + METADATA_BATCH_SIZE);
			const inspected = await this.nativeMetadata.inspect(cwd, batch, requestDirectory);
			if (inspected === undefined) {
				if (result.length > 0) {
					throw new SnapshotStoreError("capture_failed", "native metadata 能力在批次间变化");
				}
				return undefined;
			}
			result.push(...inspected);
		}
		return result;
	}

	private async collectIgnoredPresentKindsFallback(
		cwd: string,
		paths: readonly string[],
	): Promise<readonly NativeMetadataEntry["kind"][]> {
		const result: NativeMetadataEntry["kind"][] = [];
		for (let offset = 0; offset < paths.length; offset += METADATA_BATCH_SIZE) {
			const batch = paths.slice(offset, offset + METADATA_BATCH_SIZE);
			await assertNoSymlinkParents(cwd, batch);
			const kinds = await mapConcurrentOrdered(batch, FILE_SYSTEM_INSPECTION_CONCURRENCY, async (relativePath) => {
				const metadata = await lstat(join(cwd, ...relativePath.split("/"))).catch((error) => {
					if (hasErrorCode(error, "ENOENT")) return null;
					throw error;
				});
				return metadata === null
					? "absent" as const
					: metadata.isFile() ? "file" as const
					: metadata.isSymbolicLink() ? "symlink" as const
					: "other" as const;
			});
			await assertNoSymlinkParents(cwd, batch);
			result.push(...kinds);
		}
		return result;
	}

	private async stageWorktree(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: ReadonlySet<string>,
		cache: ReadonlyMap<string, CachedVisibleLeaf> | undefined,
		requestDirectory: string,
	): Promise<StagedWorktree> {
		const leaves = await this.collectVisibleLeaves(
			cwd,
			environment,
			gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
			requestDirectory,
		);
		const objectIds = new Map<string, string>();
		const uncached: VisibleLeaf[] = [];
		for (const leaf of leaves) {
			const cached = cache?.get(leaf.relativePath);
			if (
				leaf.cacheable && cached?.cacheable === true && cached.kind === leaf.kind &&
				cached.mode === leaf.mode && cached.fingerprint === leaf.fingerprint &&
				cached.verifiedAtNs > cached.changedAtNs + RACY_CLEAN_WINDOW_NS
			) {
				objectIds.set(leaf.relativePath, cached.objectId);
			} else {
				uncached.push(leaf);
			}
		}
		const hashBatches = hashPathBatches(uncached.filter((leaf) => leaf.kind === "file"));
		const hashedBatches = await mapConcurrentOrdered(hashBatches, HASH_BATCH_CONCURRENCY, async (batch) => {
			await this.assertVisibleLeavesUnchanged(cwd, batch);
			const output = await this.runGit([
				"hash-object",
				"-w",
				"--no-filters",
				"--",
				...batch.map((leaf) => leaf.relativePath),
			], { cwd, env: environment });
			const hashes = parseObjectIdLines(output, batch.length);
			await this.assertVisibleLeavesUnchanged(cwd, batch);
			return batch.map((leaf, index) => [leaf.relativePath, hashes[index]!] as const);
		});
		for (const batch of hashedBatches) {
			for (const [relativePath, objectId] of batch) objectIds.set(relativePath, objectId);
		}
		for (const leaf of uncached) {
			if (leaf.kind !== "symlink") continue;
			await assertNoSymlinkEscape(cwd, leaf.relativePath);
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
			await assertNoSymlinkEscape(cwd, leaf.relativePath);
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
		await this.assertVisibleLeavesUnchanged(cwd, leaves, requestDirectory);
		return { leaves, objectIds, verifiedAtNs: BigInt(Date.now()) * 1_000_000n };
	}

	private rememberVisibleLeaves(update: VisibleLeafCacheUpdate): void {
		const { gitDirectory, staged, inclusions } = update;
		const previous = this.visibleLeafCache.get(gitDirectory);
		const cache = inclusions !== null && inclusions.length === 0
			? new Map<string, CachedVisibleLeaf>()
			: new Map(previous);
		if (inclusions !== null && inclusions.length > 0) {
			for (const relativePath of cache.keys()) {
				if (inclusions.some((inclusion) => isPathAtOrBelow(inclusion, relativePath))) {
					cache.delete(relativePath);
				}
			}
		}
		for (const leaf of staged.leaves) {
			const objectId = staged.objectIds.get(leaf.relativePath);
			if (objectId === undefined) continue;
			if (!leaf.cacheable) {
				cache.delete(leaf.relativePath);
				continue;
			}
			cache.set(leaf.relativePath, { ...leaf, objectId, verifiedAtNs: staged.verifiedAtNs });
		}
		if (!samePersistedLeafCache(previous, cache)) {
			this.leafCacheDirtyDirectories.add(storeDirectoryForGitDirectory(gitDirectory));
		}
		this.visibleLeafCache.set(gitDirectory, cache);
	}

	/** 从 storeDirectory 读取持久化叶子缓存并合并进内存；进程内已有条目优先。 */
	private async loadPersistedLeafCache(storeDirectory: string): Promise<void> {
		if (this.leafCacheDirectoriesLoaded.has(storeDirectory)) return;
		this.leafCacheDirectoriesLoaded.add(storeDirectory);
		let file: unknown;
		try {
			file = JSON.parse(await readFile(join(storeDirectory, LEAF_CACHE_FILE), "utf8"));
		} catch {
			return; // 缺失或损坏：忽略，本次 capture 走冷路径并重建缓存。
		}
		if (!isPersistedLeafCacheFile(file)) return;
		const prefix = `${storeDirectory}${sep}`;
		for (const [gitDirectory, entries] of Object.entries(file.entries)) {
			if (!gitDirectory.startsWith(prefix) || this.visibleLeafCache.has(gitDirectory)) continue;
			const cache = new Map<string, CachedVisibleLeaf>();
			for (const [relativePath, entry] of Object.entries(entries)) {
				cache.set(relativePath, {
					relativePath,
					kind: entry.kind,
					mode: entry.mode,
					fingerprint: entry.fingerprint,
					cacheable: entry.cacheable,
					changedAtNs: BigInt(entry.changedAtNs),
					objectId: entry.objectId,
					verifiedAtNs: BigInt(entry.verifiedAtNs),
				});
			}
			this.visibleLeafCache.set(gitDirectory, cache);
		}
	}

	/** 把当前 storeDirectory 范围内的叶子缓存原子写入磁盘（best-effort）。 */
	private async persistLeafCache(storeDirectory: string): Promise<void> {
		if (!this.leafCacheDirtyDirectories.has(storeDirectory)) return;
		const prefix = `${storeDirectory}${sep}`;
		const entries: Record<string, Record<string, PersistedLeafCacheEntry>> = {};
		for (const [gitDirectory, cache] of this.visibleLeafCache) {
			if (!gitDirectory.startsWith(prefix)) continue;
			const rootEntries: Record<string, PersistedLeafCacheEntry> = {};
			for (const [relativePath, leaf] of cache) {
				rootEntries[relativePath] = {
					kind: leaf.kind,
					mode: leaf.mode,
					fingerprint: leaf.fingerprint,
					cacheable: leaf.cacheable,
					objectId: leaf.objectId,
					changedAtNs: leaf.changedAtNs.toString(),
					verifiedAtNs: leaf.verifiedAtNs.toString(),
				};
			}
			entries[gitDirectory] = rootEntries;
		}
		try {
			// 用普通 JSON 序列化（非 canonicalJson）：缓存只在本机消费，避免大规模排序开销。
			await writeBytesAtomic(
				join(storeDirectory, LEAF_CACHE_FILE),
				Buffer.from(JSON.stringify({ schemaVersion: 1, entries }), "utf8"),
				0o600,
			);
			this.leafCacheDirtyDirectories.delete(storeDirectory);
		} catch {
			// 缓存写入是 best-effort：失败只影响下次性能，不影响正确性。
		}
	}

	private async assertVisibleLeavesUnchanged(
		cwd: string,
		leaves: readonly VisibleLeaf[],
		requestDirectory?: string,
	): Promise<void> {
		if (leaves.length === 0) return;
		const paths = leaves.map((leaf) => leaf.relativePath);
		if (requestDirectory !== undefined) {
			// 分批 inspect 只核验当前批次祖先；全部可见路径必须在批次前后各包一层父目录检查。
			await assertNoSymlinkParents(cwd, paths);
			const inspected = await this.inspectNativeMetadataBatches(cwd, paths, requestDirectory);
			if (inspected !== undefined) {
				for (let index = 0; index < leaves.length; index += 1) {
					const leaf = leaves[index]!;
					const metadata = nativeVisibleLeafMetadata(inspected[index]!);
					if (metadata === null || visibleLeafFingerprint(metadata) !== leaf.fingerprint) {
						throw new SnapshotStoreError("capture_failed", `捕获期间工作区叶子已变化：${leaf.relativePath}`);
					}
				}
				await assertNoSymlinkParents(cwd, paths);
				return;
			}
			await mapConcurrentOrdered(leaves, FILE_SYSTEM_INSPECTION_CONCURRENCY, (leaf) =>
				this.assertVisibleLeafUnchanged(cwd, leaf));
			await assertNoSymlinkParents(cwd, paths);
			return;
		}
		await assertNoSymlinkParents(cwd, paths);
		await mapConcurrentOrdered(leaves, FILE_SYSTEM_INSPECTION_CONCURRENCY, (leaf) =>
			this.assertVisibleLeafUnchanged(cwd, leaf));
	}

	private async assertVisibleLeafUnchanged(cwd: string, leaf: VisibleLeaf): Promise<void> {
		const metadata = await lstat(join(cwd, ...leaf.relativePath.split("/")), { bigint: true }).catch((error) => {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		});
		if (metadata === null || visibleLeafFingerprint(visibleLeafMetadataFromStats(metadata)) !== leaf.fingerprint) {
			throw new SnapshotStoreError("capture_failed", `捕获期间工作区叶子已变化：${leaf.relativePath}`);
		}
	}

	private async queryVisibleLeafPaths(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: ReadonlySet<string>,
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
			!exactExclusions.has(relativePath));
	}

	private async collectVisibleLeaves(
		cwd: string,
		environment: Readonly<Record<string, string | undefined>>,
		gitBacked: boolean,
		inclusions: readonly string[] | null,
		exclusions: readonly string[],
		exactExclusions: ReadonlySet<string>,
		requestDirectory: string,
	): Promise<VisibleLeaf[]> {
		const paths = await this.queryVisibleLeafPaths(
			cwd,
			environment,
			gitBacked,
			inclusions,
			exclusions,
			exactExclusions,
		);
		if (paths.length === 0) return [];
		// 分批 inspect 只核验当前批次祖先；全部可见路径必须在批次前后各包一层父目录检查。
		await assertNoSymlinkParents(cwd, paths);
		const nativeEntries = await this.inspectNativeMetadataBatches(cwd, paths, requestDirectory);
		const metadataEntries = nativeEntries === undefined
			? await this.collectVisibleLeafMetadataFallback(cwd, paths)
			: nativeEntries.map((entry) => nativeVisibleLeafMetadata(entry));
		await assertNoSymlinkParents(cwd, paths);
		const leaves: VisibleLeaf[] = [];
		for (let index = 0; index < paths.length; index += 1) {
			const relativePath = paths[index]!;
			const metadata = metadataEntries[index]!;
			if (metadata === null) continue;
			if (metadata.kind === "other") {
				throw new SnapshotStoreError("capture_failed", `不支持的工作区文件类型：${relativePath}`);
			}
			const cacheable = visibleLeafMetadataCacheable(metadata);
			leaves.push({
				relativePath,
				kind: metadata.kind,
				mode: metadata.kind === "symlink"
					? 0o120000
					: (metadata.mode & 0o111n) === 0n ? 0o100644 : 0o100755,
				fingerprint: visibleLeafFingerprint(metadata),
				changedAtNs: metadata.mtimeNs > metadata.ctimeNs ? metadata.mtimeNs : metadata.ctimeNs,
				cacheable,
			});
		}
		return leaves;
	}

	private async collectVisibleLeafMetadataFallback(
		cwd: string,
		paths: readonly string[],
	): Promise<readonly (VisibleLeafMetadata | null)[]> {
		await assertNoSymlinkParents(cwd, paths);
		return mapConcurrentOrdered(paths, FILE_SYSTEM_INSPECTION_CONCURRENCY, async (relativePath) => {
			relativeSafePath(cwd, relativePath);
			const metadata = await lstat(join(cwd, ...relativePath.split("/")), { bigint: true }).catch((error) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			return metadata === null ? null : visibleLeafMetadataFromStats(metadata);
		});
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
		this.visibleLeafCache.delete(gitDirectory);
		await this.configurePrivateRepository(gitDirectory);
	}

	private async configurePrivateRepository(gitDirectory: string): Promise<void> {
		if (this.configuredPrivateRepositories.has(gitDirectory)) return;
		const environment = cleanGitEnvironment();
		await this.runGit(["--git-dir", gitDirectory, "config", "gc.auto", "0"], { env: environment });
		await this.runGit(["--git-dir", gitDirectory, "config", "maintenance.auto", "false"], { env: environment });
		this.configuredPrivateRepositories.add(gitDirectory);
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
): ReadonlySet<string> {
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
	return new Set(result);
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

function rootCaptureCoverage(
	rootPath: string,
	scope: readonly string[] | undefined,
	roots?: readonly RootTopologyIdentity[],
): string {
	const requestedInclusions = rootScopePathspecs(rootPath, scope);
	if (roots === undefined) return rootCoverageFromInclusions(requestedInclusions);
	const exclusions = roots
		.filter((root) => isStrictRootAncestor(rootPath, root.relativeRoot))
		.map((root) => rootRelativePath(rootPath, root.relativeRoot));
	return rootCoverageFromInclusions(ownedRootInclusions(requestedInclusions, exclusions));
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

function brokenRootPaths(topology: Pick<RootTopology, "roots">): string[] {
	return topology.roots.filter((root) => root.state === "broken").map((root) => root.relativeRoot);
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

function storeDirectoryForGitDirectory(gitDirectory: string): string {
	return dirname(dirname(dirname(gitDirectory)));
}

function samePersistedLeafCache(
	left: ReadonlyMap<string, CachedVisibleLeaf> | undefined,
	right: ReadonlyMap<string, CachedVisibleLeaf>,
): boolean {
	if (left === undefined) return right.size === 0;
	if (left.size !== right.size) return false;
	for (const [path, entry] of right) {
		const existing = left.get(path);
		const existingTrusted = existing !== undefined &&
			existing.verifiedAtNs > existing.changedAtNs + RACY_CLEAN_WINDOW_NS;
		const entryTrusted = entry.verifiedAtNs > entry.changedAtNs + RACY_CLEAN_WINDOW_NS;
		if (
			existing === undefined ||
			existing.kind !== entry.kind ||
			existing.mode !== entry.mode ||
			existing.fingerprint !== entry.fingerprint ||
			existing.cacheable !== entry.cacheable ||
			existing.objectId !== entry.objectId ||
			existing.changedAtNs !== entry.changedAtNs ||
			existingTrusted !== entryTrusted
		) return false;
	}
	return true;
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

function visibleLeafMetadataFromStats(metadata: BigIntStats): VisibleLeafMetadata {
	return {
		kind: metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "other",
		dev: metadata.dev,
		ino: metadata.ino,
		mode: metadata.mode,
		size: metadata.size,
		mtimeNs: metadata.mtimeNs,
		ctimeNs: metadata.ctimeNs,
	};
}

function nativeVisibleLeafMetadata(entry: NativeMetadataEntry): VisibleLeafMetadata | null {
	if (entry.kind === "absent") return null;
	if (
		entry.dev === undefined || entry.ino === undefined || entry.mode === undefined ||
		entry.size === undefined || entry.mtimeNs === undefined || entry.ctimeNs === undefined
	) {
		throw new SnapshotStoreError("capture_failed", `native metadata 缺少字段：${entry.path}`);
	}
	return {
		kind: entry.kind,
		dev: entry.dev,
		ino: entry.ino,
		mode: entry.mode,
		size: entry.size,
		mtimeNs: entry.mtimeNs,
		ctimeNs: entry.ctimeNs,
	};
}

function isPersistedLeafCacheFile(value: unknown): value is PersistedLeafCacheFile {
	if (typeof value !== "object" || value === null) return false;
	const file = value as { schemaVersion?: unknown; entries?: unknown };
	if (file.schemaVersion !== 1 || typeof file.entries !== "object" || file.entries === null) return false;
	for (const entries of Object.values(file.entries as Record<string, unknown>)) {
		if (typeof entries !== "object" || entries === null) return false;
		for (const entry of Object.values(entries as Record<string, unknown>)) {
			if (typeof entry !== "object" || entry === null) return false;
			const candidate = entry as Partial<PersistedLeafCacheEntry>;
			if (
				(candidate.kind !== "file" && candidate.kind !== "symlink") ||
				typeof candidate.mode !== "number" ||
				typeof candidate.fingerprint !== "string" ||
				typeof candidate.cacheable !== "boolean" ||
				typeof candidate.objectId !== "string" ||
				typeof candidate.changedAtNs !== "string" ||
				typeof candidate.verifiedAtNs !== "string" ||
				!/^[0-9]+$/.test(candidate.changedAtNs) ||
				!/^[0-9]+$/.test(candidate.verifiedAtNs)
			) {
				return false;
			}
		}
	}
	return true;
}

function visibleLeafFingerprint(metadata: VisibleLeafMetadata): string {
	return checksum(canonicalJson({
		kind: metadata.kind,
		dev: metadata.dev.toString(),
		ino: metadata.ino.toString(),
		mode: metadata.mode.toString(),
		size: metadata.size.toString(),
		mtimeNs: metadata.mtimeNs.toString(),
		ctimeNs: metadata.ctimeNs.toString(),
	}));
}

function visibleLeafMetadataCacheable(metadata: VisibleLeafMetadata): boolean {
	// dev/ino/ctime 缺失时无法证明路径仍指向同一未修改对象，必须回退内容 hash。
	return metadata.dev !== 0n && metadata.ino !== 0n && metadata.ctimeNs > 0n;
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
	const paths: string[] = [];
	for (const record of splitNulRecords(output)) {
		const path = decodeUtf8(record);
		// git 在嵌套仓库边界会输出折叠的目录项（如 "dir/"）；该目录由 root discovery
		// 作为独立 root 捕获，不属于本仓库的路径枚举，直接跳过。
		if (path.endsWith("/")) continue;
		relativeSafePath("/", path);
		paths.push(path);
	}
	return paths;
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

function samePathList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((path, index) => path === right[index]);
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
