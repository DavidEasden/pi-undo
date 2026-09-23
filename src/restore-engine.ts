import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { writeJsonAtomic } from "./atomic-fs.ts";
import {
	createDurablePack,
	hasDurablePack,
	loadDurablePack,
	publishCachedDurablePack,
	removeDurablePack,
	type DurableLeafInput,
	type DurablePack,
	type DurablePackEntryInput,
} from "./durable-pack.ts";
import { assertManifest, assertOperationId, canonicalJson, checksum } from "./encoding.ts";
import { MutationJournal } from "./mutation-journal.ts";
import { allCompleted, checkOperation, rethrowOperationFailure, isUnconfirmedExit, operationFailure, withRecoveryBudget } from "./operation-context.ts";
import { createNativeFileBatch, nativeRestoreCapability } from "./native-restore.ts";
import { recoverPackedMutations } from "./packed-recovery.ts";
import type { ManifestId, RestorePath, SnapshotManifest, SnapshotRoot } from "./model.ts";
import {
	assertNoSymlinkEscape,
	relativeSafePath,
	sortDeletePaths,
	sortWritePaths,
} from "./path-safety.ts";
import { RootDiscovery, type RootTopology } from "./root-discovery.ts";
import {
	QuarantineManager,
	fingerprintAbsent,
	fingerprintBytes,
	fingerprintSymlink,
	type DeleteLeafRequest,
	type ReplaceFileRequest,
} from "./quarantine.ts";
import { SnapshotStore, SnapshotStoreError } from "./snapshot-store.ts";
import { WorkspaceLock } from "./workspace-lock.ts";

const PREPARED_PLAN_CACHE_LIMIT = 16;
const DURABLE_CACHE_INDEX_FILE = "index.json";
const DURABLE_PACK_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
const RESTORE_FILE_BATCH_MAX_ENTRIES = 1_024;
const RESTORE_FILE_BATCH_MAX_BYTES = 64 * 1024 * 1024;
const RESTORE_FILE_PREPARE_CONCURRENCY = 32;
const RESTORE_FILE_VERIFY_CONCURRENCY = 32;

export interface RestorePlan {
	currentManifestId: ManifestId;
	targetManifestId: ManifestId;
	boundaryRoots: string[];
	deletePaths: string[];
	writePaths: string[];
	scopePaths?: string[];
	planDigest: string;
}

export interface RestoreResult {
	code: "ok" | "restore_failed_safe" | "partial_restore" | "recovery_required";
	verifiedPaths: number;
	totalPaths: number;
	postFingerprint?: string;
	failureCode?: "operation_cancelled" | "operation_timeout";
}

export interface RestoreEngine {
	plan(current: SnapshotManifest, target: SnapshotManifest, scopePaths?: readonly string[]): Promise<RestorePlan>;
	apply(plan: RestorePlan, target: SnapshotManifest, options?: RestoreApplyOptions): Promise<RestoreResult>;
}

export interface RestoreApplyOptions {
	readonly opId: string;
	readonly mutationJournal: MutationJournal;
	readonly forceTargetArtifactSync?: boolean;
	readonly deferDurability?: boolean;
}

export interface RestoreEngineOptions {
	readonly workspaceRoot: string;
	readonly store: SnapshotStore;
	readonly discovery?: RootDiscovery;
	readonly beforeMutation?: (mutation: RestoreMutation) => void | Promise<void>;
	/** 仅用于测试：覆盖进程内已加载 durable pack 的内存预算。 */
	readonly durablePackCacheMaxBytes?: number;
}

export interface RestoreMutation {
	readonly phase: "apply" | "rollback";
	readonly ordinal: number;
	readonly kind: "delete" | "mkdir" | "write" | "symlink";
	readonly path: string;
}

interface OwnedPath {
	readonly absolutePath: string;
	readonly entry: RestorePath;
	readonly root: SnapshotRoot;
}

interface VisibleSubsetCheck {
	/**
	 * 调用方刚刚完成 topology discovery 且随后没有文件 mutation 时为 true，可跳过枚举入口的重复校验。
	 * 枚举结束后的校验仍然执行，所以该窗口内的漂移依然被拒绝。
	 */
	readonly topologyValidated: boolean;
	readonly extraExclusions?: readonly string[];
	readonly scopePaths?: readonly string[];
	readonly ownedPaths?: readonly (ReadonlyMap<string, OwnedPath> | undefined)[];
}

interface PreparedRestorePlan {
	readonly plan: RestorePlan;
	readonly currentPaths: ReadonlyMap<string, OwnedPath>;
	readonly targetPaths: ReadonlyMap<string, OwnedPath>;
}

interface DurableCacheIndexEntry {
	readonly currentManifestId: ManifestId;
	readonly targetManifestId: ManifestId;
	readonly scopePaths: readonly string[];
	readonly planDigest: string;
	readonly packChecksum: string;
}

interface DurableCacheIndex {
	readonly schemaVersion: 1;
	entries: DurableCacheIndexEntry[];
}

interface CachedDurablePack {
	readonly currentManifestId: ManifestId;
	readonly targetManifestId: ManifestId;
	readonly path: string;
	readonly packChecksum: string;
	readonly pinReason: string;
	readonly pinsDeferred: boolean;
}

interface CachedDurablePair {
	readonly planDigest: string;
	readonly pack: DurablePack;
	readonly bytes: number;
}

type DurableIndexDisk =
	| { readonly kind: "ok"; readonly index: DurableCacheIndex }
	| { readonly kind: "missing" }
	| { readonly kind: "corrupt" }
	| { readonly kind: "unavailable" };

interface MutationContext {
	readonly phase: RestoreMutation["phase"];
	readonly sourceManifestId: ManifestId;
	readonly targetManifestId: ManifestId;
	readonly sourcePaths: ReadonlyMap<string, OwnedPath>;
	readonly targetPaths: ReadonlyMap<string, OwnedPath>;
	readonly plannedDeletePaths: ReadonlySet<string>;
	readonly sourceIgnoredPaths: ReadonlySet<string>;
	readonly mutationJournal: MutationJournal;
	readonly quarantine: QuarantineManager;
	ordinal: number;
}

export class RestoreEngine {
	private readonly requestedWorkspaceRoot: string;
	private readonly workspaceRoot: string;
	private readonly store: SnapshotStore;
	private readonly discovery: RootDiscovery;
	private readonly beforeMutation: RestoreEngineOptions["beforeMutation"];
	private readonly preparedPlans = new Map<string, PreparedRestorePlan>();
	private readonly durablePackCache = new Map<string, CachedDurablePack>();
	private readonly durablePackByPair = new Map<string, CachedDurablePair>();
	private readonly durableIndexLock = new WorkspaceLock({
		leaseMs: 10_000,
		retryMs: 25,
		acquireTimeoutMs: 1_000,
	});
	private readonly durablePackCacheMaxBytes: number;
	private durableIndex: DurableCacheIndex | undefined;
	private durableIndexQueue: Promise<void> = Promise.resolve();
	private durablePackMemoryBytes = 0;

	constructor(options: RestoreEngineOptions) {
		this.requestedWorkspaceRoot = resolve(options.workspaceRoot);
		this.workspaceRoot = realpathSync(this.requestedWorkspaceRoot);
		this.store = options.store;
		this.discovery = options.discovery ?? new RootDiscovery();
		this.beforeMutation = options.beforeMutation;
		this.durablePackCacheMaxBytes = options.durablePackCacheMaxBytes ?? DURABLE_PACK_MEMORY_MAX_BYTES;
		if (!Number.isSafeInteger(this.durablePackCacheMaxBytes) || this.durablePackCacheMaxBytes <= 0) {
			throw new Error("durable pack 内存预算必须是正整数");
		}
	}

	private async compatibleApplyOptions(): Promise<{
		readonly directory: string;
		readonly options: RestoreApplyOptions;
	}> {
		const directory = await mkdtemp(join(tmpdir(), "pi-undo-restore-compat-"));
		const opId = `compat-${randomUUID()}`;
		return {
			directory,
			options: {
				opId,
				mutationJournal: new MutationJournal(join(directory, "mutations.jsonl"), opId),
			},
		};
	}

	async plan(
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths?: readonly string[],
	): Promise<RestorePlan> {
		assertManifest(current);
		assertManifest(target);
		const scope = scopePaths === undefined ? undefined : this.canonicalScope(scopePaths);
		const canonicalScopePaths = scope === undefined ? undefined : [...scope];
		assertCompatibleManifests(current, target, scope);
		const isScopedPath = (path: string): boolean => scope === undefined || scope.has(path);
		await allCompleted([
			this.store.assertComplete(current.manifestId, canonicalScopePaths),
			this.store.assertComplete(target.manifestId, canonicalScopePaths),
		]);

		const [currentPaths, targetPaths] = await allCompleted([
			this.readOwnedPaths(current, canonicalScopePaths),
			this.readOwnedPaths(target, canonicalScopePaths),
		]);
		const targetIgnoredProof = new IgnoredProofIndex(ignoredWorkspacePaths(target));
		const deleteByRoot = new Map<string, string[]>();
		const writeByRoot = new Map<string, string[]>();

		for (const [path, owned] of currentPaths) {
			if (!isScopedPath(path)) continue;
			const targetOwned = targetPaths.get(path);
			if (targetOwned !== undefined && !sameEntry(owned.entry, targetOwned.entry)) {
				if (targetOwned.entry.kind !== owned.entry.kind || targetOwned.entry.kind === "symlink") {
					appendPath(deleteByRoot, owned.root.relativeRoot, path);
				}
				continue;
			}
			if (targetOwned === undefined) {
				if (targetIgnoredProof.isProtected(path, owned.entry.kind)) {
					continue;
				}
				appendPath(deleteByRoot, owned.root.relativeRoot, path);
			}
		}

		for (const [path, owned] of targetPaths) {
			if (!isScopedPath(path)) continue;
			const currentOwned = currentPaths.get(path);
			if (currentOwned === undefined || !sameEntry(currentOwned.entry, owned.entry)) {
				appendPath(writeByRoot, owned.root.relativeRoot, path);
			}
		}

		const boundaryRoots = [...new Set([
			...current.roots.map((root) => root.relativeRoot),
			...target.roots.map((root) => root.relativeRoot),
		])].sort(comparePaths);
		const deletePaths = sortDeletePaths([...deleteByRoot.values()].flat());
		const writePaths = orderedWritePaths(target.roots, writeByRoot, targetPaths);
		const semanticPlan = {
			currentManifestId: current.manifestId,
			targetManifestId: target.manifestId,
			boundaryRoots,
			deletePaths,
			writePaths,
			...(scope === undefined ? {} : { scopePaths: [...scope] }),
		};
		const plan = {
			...semanticPlan,
			planDigest: checksum(canonicalJson(semanticPlan)),
		};
		this.rememberPreparedPlan(plan, currentPaths, targetPaths);
		return plan;
	}

	async canReuseDurableSource(
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths: readonly string[],
	): Promise<boolean> {
		const pairKey = durablePairKey(current.manifestId, target.manifestId, scopePaths);
		let cached = this.durablePackByPair.get(pairKey);
		if (cached !== undefined && !this.durablePackCache.has(cached.planDigest)) {
			this.dropResidentDurablePack(pairKey);
			cached = undefined;
		}
		const fromPersistentIndex = cached === undefined;
		if (cached === undefined) {
			cached = await this.readIndexedDurablePack(current.manifestId, target.manifestId, scopePaths);
		}
		if (cached === undefined || cached.pack.opId !== `cache-${cached.planDigest}`) return false;
		const cacheJournal = new MutationJournal(
			join(dirname(cached.pack.storagePath), "mutations.jsonl"),
			`cache-${cached.planDigest}`,
		);
		try {
			if (await this.assertWorkspaceRootIdentity() !== current.workspaceIdentity) return false;
			if (fromPersistentIndex) {
				const expected = await this.plan(current, target, scopePaths);
				if (expected.planDigest !== cached.planDigest) return false;
			}
			const topology = await this.discovery.discover(this.workspaceRoot, "safety-snapshot");
			this.assertCurrentTopology(current, target, topology);
			const native = await createNativeFileBatch({
				workspaceRoot: this.workspaceRoot,
				planDigest: cached.planDigest,
				journal: cacheJournal,
				requiredCapability: nativeRestoreCapability(cached.pack),
			});
			if (native === undefined || !await native.verifySource(cached.pack)) return false;
			if (fromPersistentIndex) {
				await this.rememberDurablePackInMemory(
					cached.planDigest,
					current,
					target,
					scopePaths,
					cached.pack,
					`durable-cache:${cached.planDigest}`,
					false,
				);
			}
			return true;
		} catch (error) {
			rethrowOperationFailure(error);
			return false;
		}
	}

	async prepareDurableRestore(
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths: readonly string[],
	): Promise<void> {
		const plan = await this.plan(current, target, scopePaths);
		const prepared = this.takePreparedPlan(plan);
		if (prepared === undefined || !this.canUseNativeFilePlan(plan, prepared.currentPaths, prepared.targetPaths)) return;
		const cacheRoot = await this.store.durableCacheDirectory();
		const cacheOpId = `cache-${plan.planDigest}`;
		const cacheJournal = new MutationJournal(
			join(cacheRoot, plan.planDigest, "mutations.jsonl"),
			cacheOpId,
		);
		await mkdir(dirname(cacheJournal.storagePath), { recursive: true });
		const pack = await createDurablePack(cacheJournal, {
			opId: cacheOpId,
			planDigest: plan.planDigest,
			entries: await this.durablePackEntries(
				current,
				target,
				prepared.currentPaths,
				prepared.targetPaths,
				plan,
				cacheOpId,
			),
		});
		const pinReason = `durable-cache:${plan.planDigest}`;
		const pinned: ManifestId[] = [];
		try {
			for (const manifestId of new Set([current.manifestId, target.manifestId])) {
				await this.store.pin(manifestId, pinReason);
				pinned.push(manifestId);
			}
		} catch (error) {
			await Promise.all(pinned.map((manifestId) => this.store.unpin(manifestId, pinReason).catch(() => {})));
			await rm(dirname(pack.storagePath), { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		await this.rememberDurablePack(
			plan.planDigest,
			current,
			target,
			scopePaths,
			pack,
			pinReason,
		);
		this.rememberPreparedPlan(plan, prepared.currentPaths, prepared.targetPaths);
	}

	private async rememberDurablePack(
		planDigest: string,
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths: readonly string[],
		pack: DurablePack,
		pinReason: string,
	): Promise<void> {
		await this.rememberDurablePackInMemory(planDigest, current, target, scopePaths, pack, pinReason, true);
		await this.enqueueDurableIndex(async () => {
			const lease = await this.acquireDurableIndexLease();
			if (lease === undefined) return;
			try {
				const disk = await this.readDurableIndexFromDisk();
				if (disk.kind === "unavailable") return;
				this.durableIndex = disk.kind === "ok"
					? disk.index
					: { schemaVersion: 1, entries: [] };
				this.upsertDurableIndexEntry({
					currentManifestId: current.manifestId,
					targetManifestId: target.manifestId,
					scopePaths: [...scopePaths],
					planDigest,
					packChecksum: pack.packChecksum,
				});
				await this.evictPersistedDurablePacks(planDigest);
				await this.persistDurableIndex();
			} finally {
				await lease.release().catch(() => {});
			}
		});
	}

	private async rememberDurablePackInMemory(
		planDigest: string,
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths: readonly string[],
		pack: DurablePack,
		pinReason: string,
		pinsDeferred: boolean,
	): Promise<void> {
		this.durablePackCache.delete(planDigest);
		this.durablePackCache.set(planDigest, {
			currentManifestId: current.manifestId,
			targetManifestId: target.manifestId,
			path: pack.storagePath,
			packChecksum: pack.packChecksum,
			pinReason,
			pinsDeferred,
		});
		this.trimDurablePackMetadata();
		await this.rememberResidentDurablePack(
			durablePairKey(current.manifestId, target.manifestId, scopePaths),
			planDigest,
			pack,
		);
	}

	private trimDurablePackMetadata(): void {
		while (this.durablePackCache.size > PREPARED_PLAN_CACHE_LIMIT) {
			const oldest = this.durablePackCache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.durablePackCache.delete(oldest);
			this.dropResidentDurablePacks(oldest);
		}
	}

	private async rememberResidentDurablePack(
		pairKey: string,
		planDigest: string,
		pack: DurablePack,
	): Promise<void> {
		const bytes = await this.durablePackFileBytes(pack.storagePath);
		const previous = this.durablePackByPair.get(pairKey);
		if (previous !== undefined) {
			this.durablePackMemoryBytes -= previous.bytes;
			this.durablePackByPair.delete(pairKey);
		}
		this.durablePackByPair.set(pairKey, { planDigest, pack, bytes });
		this.durablePackMemoryBytes += bytes;
		while (this.durablePackMemoryBytes > this.durablePackCacheMaxBytes) {
			const oldest = this.durablePackByPair.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.dropResidentDurablePack(oldest);
		}
	}

	private dropResidentDurablePack(pairKey: string): void {
		const cached = this.durablePackByPair.get(pairKey);
		if (cached === undefined) return;
		this.durablePackByPair.delete(pairKey);
		this.durablePackMemoryBytes = Math.max(0, this.durablePackMemoryBytes - cached.bytes);
	}

	private dropResidentDurablePacks(planDigest: string): void {
		for (const [pairKey, cached] of this.durablePackByPair) {
			if (cached.planDigest === planDigest) this.dropResidentDurablePack(pairKey);
		}
	}

	private async readIndexedDurablePack(
		currentManifestId: ManifestId,
		targetManifestId: ManifestId,
		scopePaths: readonly string[],
	): Promise<CachedDurablePair | undefined> {
		const pairKey = durablePairKey(currentManifestId, targetManifestId, scopePaths);
		const existing = this.durablePackByPair.get(pairKey);
		if (existing !== undefined && this.durablePackCache.has(existing.planDigest)) return existing;
		if (existing !== undefined) this.dropResidentDurablePack(pairKey);
		const disk = await this.enqueueDurableIndex(async () => {
			const result = await this.readDurableIndexFromDisk();
			if (result.kind === "ok") this.durableIndex = result.index;
			return result;
		});
		const entries = disk.kind === "ok"
			? disk.index.entries
			: disk.kind === "unavailable" ? this.durableIndex?.entries : undefined;
		const entry = entries?.find((candidate) =>
			durablePairKey(candidate.currentManifestId, candidate.targetManifestId, candidate.scopePaths) === pairKey);
		if (entry === undefined || !isDigest(entry.planDigest) || !isDigest(entry.packChecksum)) return undefined;
		try {
			const cacheRoot = await this.store.durableCacheDirectory();
			const journal = new MutationJournal(
				join(cacheRoot, entry.planDigest, "mutations.jsonl"),
				`cache-${entry.planDigest}`,
			);
			if (!await hasDurablePack(journal)) return undefined;
			const pack = await loadDurablePack(journal, entry.planDigest, true);
			if (pack.packChecksum !== entry.packChecksum || pack.planDigest !== entry.planDigest) return undefined;
			return {
				planDigest: entry.planDigest,
				pack,
				bytes: await this.durablePackFileBytes(pack.storagePath),
			};
		} catch {
			return undefined;
		}
	}

	private enqueueDurableIndex<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.durableIndexQueue.then(operation, operation);
		this.durableIndexQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async acquireDurableIndexLease(): Promise<{ release(): Promise<void> } | undefined> {
		try {
			return await this.durableIndexLock.acquire(await this.durableIndexLockIdentity());
		} catch (error) {
			rethrowOperationFailure(error);
			return undefined;
		}
	}

	private async durableIndexLockIdentity(): Promise<string> {
		const cacheRoot = await this.store.durableCacheDirectory();
		try {
			return `durable-cache:${await realpath(cacheRoot)}`;
		} catch {
			return `durable-cache:${resolve(cacheRoot)}`;
		}
	}

	private async readDurableIndexFromDisk(): Promise<DurableIndexDisk> {
		try {
			const cacheRoot = await this.store.durableCacheDirectory();
			const raw = await readFile(join(cacheRoot, DURABLE_CACHE_INDEX_FILE), "utf8");
			try {
				return { kind: "ok", index: parseDurableCacheIndex(JSON.parse(raw)) };
			} catch {
				return { kind: "corrupt" };
			}
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
			return { kind: "unavailable" };
		}
	}

	private upsertDurableIndexEntry(entry: DurableCacheIndexEntry): void {
		const index = this.durableIndex ?? { schemaVersion: 1, entries: [] };
		const pairKey = durablePairKey(entry.currentManifestId, entry.targetManifestId, entry.scopePaths);
		index.entries = index.entries.filter((candidate) =>
			candidate.planDigest !== entry.planDigest &&
			durablePairKey(candidate.currentManifestId, candidate.targetManifestId, candidate.scopePaths) !== pairKey);
		index.entries.push(entry);
		this.durableIndex = index;
	}

	private async persistDurableIndex(): Promise<void> {
		if (this.durableIndex === undefined) return;
		try {
			const cacheRoot = await this.store.durableCacheDirectory();
			await writeJsonAtomic(join(cacheRoot, DURABLE_CACHE_INDEX_FILE), {
				schemaVersion: 1,
				entries: this.durableIndex.entries,
			});
		} catch {
			// 索引只是跨会话候选提示；写入失败不得让已经 pin 成功的 pack 准备失败。
		}
	}

	private async evictPersistedDurablePacks(keepPlanDigest: string): Promise<void> {
		while (this.durableIndex !== undefined && this.durableIndex.entries.length > PREPARED_PLAN_CACHE_LIMIT) {
			const oldest = this.durableIndex.entries.find((entry) => entry.planDigest !== keepPlanDigest);
			if (oldest === undefined) break;
			await this.dropPersistedDurablePack(oldest.planDigest);
		}
	}

	private async dropPersistedDurablePack(planDigest: string): Promise<void> {
		const cached = this.durablePackCache.get(planDigest);
		const indexed = this.durableIndex?.entries.find((entry) => entry.planDigest === planDigest);
		this.durablePackCache.delete(planDigest);
		this.dropResidentDurablePacks(planDigest);
		if (this.durableIndex !== undefined) {
			this.durableIndex.entries = this.durableIndex.entries.filter((entry) => entry.planDigest !== planDigest);
		}
		const pinReason = cached?.pinReason ?? `durable-cache:${planDigest}`;
		const manifests = [...new Set([
			...(cached === undefined ? [] : [cached.currentManifestId, cached.targetManifestId]),
			...(indexed === undefined ? [] : [indexed.currentManifestId, indexed.targetManifestId]),
		])];
		await Promise.all(manifests.map((manifestId) => this.store.unpin(manifestId, pinReason).catch(() => {})));
		try {
			await rm(join(await this.store.durableCacheDirectory(), planDigest), { recursive: true, force: true });
		} catch {
			// 淘汰失败只影响缓存占用，不影响当前 restore 正确性。
		}
	}

	private async durablePackFileBytes(path: string): Promise<number> {
		try {
			const stats = await lstat(path);
			if (stats.isFile() && !stats.isSymbolicLink() && stats.size > 0) return Number(stats.size);
		} catch {
			// 文件可能在加载后被其他进程淘汰；不能把已加载的 pack 当作零字节常驻。
		}
		return this.durablePackCacheMaxBytes + 1;
	}

	private rememberPreparedPlan(
		plan: RestorePlan,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
	): void {
		const cachedPlan = cloneRestorePlan(plan);
		this.preparedPlans.set(preparedPlanKey(cachedPlan), { plan: cachedPlan, currentPaths, targetPaths });
		while (this.preparedPlans.size > PREPARED_PLAN_CACHE_LIMIT) {
			const oldest = this.preparedPlans.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.preparedPlans.delete(oldest);
		}
	}

	private takePreparedPlan(plan: RestorePlan): PreparedRestorePlan | undefined {
		const key = preparedPlanKey(plan);
		const prepared = this.preparedPlans.get(key);
		if (prepared !== undefined) this.preparedPlans.delete(key);
		return prepared;
	}

	async apply(
		plan: RestorePlan,
		target: SnapshotManifest,
		options?: RestoreApplyOptions,
	): Promise<RestoreResult> {
		const compatibility = options === undefined ? await this.compatibleApplyOptions() : undefined;
		const effectiveOptions = options ?? compatibility!.options;
		try {
			return await this.applyWithOptions(plan, target, effectiveOptions, compatibility !== undefined);
		} finally {
			if (compatibility !== undefined && await this.mutationsAreClean(effectiveOptions.mutationJournal)) {
				await rm(compatibility.directory, { recursive: true });
			}
		}
	}

	private async applyWithOptions(
		plan: RestorePlan,
		target: SnapshotManifest,
		effectiveOptions: RestoreApplyOptions,
		compatibilityMode: boolean,
	): Promise<RestoreResult> {
		assertManifest(target);
		// Task 6 会由 controller 强制传入 operation identity；此兼容分支仅保持现有调用方可运行。
		assertOperationId(effectiveOptions.opId);
		if (effectiveOptions.opId !== effectiveOptions.mutationJournal.operationId) {
			throw new Error("restore opId 与 mutation journal identity 不匹配");
		}
		if (plan.targetManifestId !== target.manifestId) {
			throw new Error("restore plan target manifest ID 不匹配");
		}
		if (!/^[0-9a-f]{64}$/.test(plan.planDigest)) {
			throw new Error("restore plan digest 无效");
		}
		if (!hasValidPlanDigest(plan)) {
			throw new Error("restore plan digest 与语义字段不匹配");
		}
		const cachedDurablePack = this.durablePackCache.get(plan.planDigest);
		const pinsDeferred = effectiveOptions.deferDurability === true &&
			cachedDurablePack?.pinsDeferred === true;
		const recoveryReason = `restore:${plan.planDigest}`;
		const attemptReason = `${recoveryReason}:attempt:${randomUUID()}`;
		const pinned = [...new Set([plan.currentManifestId, target.manifestId])];
		const acquired: ManifestId[] = [];
		try {
			if (!pinsDeferred) {
				for (const manifestId of pinned) {
					await this.store.pin(manifestId, attemptReason);
					acquired.push(manifestId);
				}
			}
		} catch (error) {
			await Promise.all(acquired.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			throw error;
		}

		try {
			const result = await this.applyPinned(
				plan,
				target,
				effectiveOptions,
				compatibilityMode,
				pinsDeferred,
			);
			if (result.code === "partial_restore" || result.code === "recovery_required") {
				let recoveryPinned = !pinsDeferred;
				for (const manifestId of recoveryPinned ? pinned : []) {
					try {
						await this.store.pin(manifestId, recoveryReason);
					} catch {
						recoveryPinned = false;
						break;
					}
				}
				if (recoveryPinned) {
					await Promise.all(acquired.map(
						(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
					));
				}
				return result;
			}

			await Promise.all(acquired.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			if (!pinsDeferred && (result.code === "ok" || result.postFingerprint !== undefined)) {
				await Promise.all(pinned.map(
					(manifestId) => this.store.unpin(manifestId, recoveryReason).catch(() => {}),
				));
			}
			return result;
		} catch (error) {
			await Promise.all(acquired.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			throw error;
		}
	}

	private async applyPinned(
		plan: RestorePlan,
		target: SnapshotManifest,
		options: RestoreApplyOptions,
		compatibilityMode: boolean,
		pinsDeferred: boolean,
	): Promise<RestoreResult> {
		const [current, storedTarget] = await allCompleted([
			this.store.loadManifest(plan.currentManifestId),
			this.store.loadManifest(target.manifestId),
		]);
		if (canonicalJson(storedTarget) !== canonicalJson(target)) {
			throw new Error("target manifest 与 store 内容不一致");
		}
		assertCompatibleManifests(
			current,
			target,
			plan.scopePaths === undefined ? undefined : this.canonicalScope(plan.scopePaths),
		);
		let expectedPlan: RestorePlan;
		let prepared = options.deferDurability === true ? this.takePreparedPlan(plan) : undefined;
		try {
			if (prepared === undefined) {
				expectedPlan = await this.plan(current, target, plan.scopePaths);
				prepared = this.takePreparedPlan(expectedPlan);
			} else {
				expectedPlan = prepared.plan;
			}
		} catch (error) {
			if (error instanceof SnapshotStoreError && error.code === "object_missing") {
				return { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 };
			}
			throw error;
		}
		if (canonicalJson(plan) !== canonicalJson(expectedPlan)) {
			throw new Error("restore plan 已被篡改或与 manifest 不匹配");
		}

		let topologyBefore: RootTopology;
		try {
			if (await this.assertWorkspaceRootIdentity() !== current.workspaceIdentity) {
				throw new Error("restore workspace root 必须使用 canonical identity");
			}
			topologyBefore = await this.discovery.discover(this.workspaceRoot, "restore-pre");
			this.assertCurrentTopology(current, target, topologyBefore);
		} catch (error) {
			rethrowOperationFailure(error);
			return { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 };
		}
		const [currentPaths, targetPaths] = prepared === undefined
			? await allCompleted([
				this.readOwnedPaths(current, plan.scopePaths),
				this.readOwnedPaths(target, plan.scopePaths),
			])
			: [prepared.currentPaths, prepared.targetPaths];
		if (compatibilityMode) {
			const compatibilityQuarantine = new QuarantineManager({
				workspaceRoot: this.requestedWorkspaceRoot,
				journal: options.mutationJournal,
			});
			if (!await this.restorePendingMutations(compatibilityQuarantine, options.mutationJournal)) {
				return { code: "recovery_required", verifiedPaths: 0, totalPaths: currentPaths.size };
			}
		} else if ((await options.mutationJournal.activeArtifacts()).size > 0) {
			return { code: "recovery_required", verifiedPaths: 0, totalPaths: currentPaths.size };
		}
		try {
			// 兼容恢复路径会先在此窗口内补偿 pending mutations，因此只有非补偿路径可以跳过枚举入口的重复发现。
			await this.assertCompleteVisibleSubset(
				topologyBefore,
				[current, target],
				options.mutationJournal,
				{
					topologyValidated: !compatibilityMode,
					scopePaths: plan.scopePaths,
					ownedPaths: [currentPaths, targetPaths],
				},
			);
		} catch (error) {
			rethrowOperationFailure(error);
			return { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 };
		}
		let durablePack: DurablePack | undefined;
		if (
			!compatibilityMode &&
			options.deferDurability === true &&
			options.forceTargetArtifactSync !== true &&
			this.canUseNativeFilePlan(plan, currentPaths, targetPaths)
		) {
			try {
				const cached = this.durablePackCache.get(plan.planDigest);
				if (
					cached !== undefined &&
					cached.currentManifestId === current.manifestId &&
					cached.targetManifestId === target.manifestId
				) {
					durablePack = await publishCachedDurablePack(
						cached.path,
						options.mutationJournal,
						plan.planDigest,
						cached.packChecksum,
					);
				} else {
					durablePack = await createDurablePack(options.mutationJournal, {
						opId: options.opId,
						planDigest: plan.planDigest,
						entries: await this.durablePackEntries(current, target, currentPaths, targetPaths, plan, options.opId),
					});
				}
			} catch (error) {
				rethrowOperationFailure(error);
				await removeDurablePack(options.mutationJournal).catch(() => {});
			}
		}
		const nativeFileBatch = durablePack !== undefined && this.beforeMutation === undefined
			? await createNativeFileBatch({
				workspaceRoot: this.workspaceRoot,
				planDigest: plan.planDigest,
				journal: options.mutationJournal,
				requiredCapability: nativeRestoreCapability(durablePack),
			})
			: undefined;
		if (durablePack !== undefined && nativeFileBatch === undefined) {
			await removeDurablePack(options.mutationJournal).catch(() => {});
			durablePack = undefined;
		}
		if (pinsDeferred && durablePack === undefined) {
			return this.applyWithOptions(
				plan,
				target,
				{ ...options, deferDurability: false },
				compatibilityMode,
			);
		}
		const durablePackEnabled = durablePack !== undefined;
		if (nativeFileBatch !== undefined && durablePack !== undefined && this.canUseNativeFilePlan(plan, currentPaths, targetPaths)) {
			const result = await this.applyNativeFilePlan(
				plan,
				current,
				target,
				currentPaths,
				targetPaths,
				topologyBefore,
				options,
				durablePack,
				nativeFileBatch.run,
			);
			return result;
		}
		try {
			await this.prefetchCompleteRestoreBlobs(plan, current, target, currentPaths, targetPaths);
		} catch (error) {
			rethrowOperationFailure(error);
			// 预取是性能优化；失败时继续走原有逐文件校验和可恢复 mutation 路径。
		}
		const preflight = await this.verifyKnownState(current, target, currentPaths, targetPaths, plan.scopePaths);
		if (!preflight.ok) {
			return {
				code: "restore_failed_safe",
				verifiedPaths: preflight.verifiedPaths,
				totalPaths: preflight.totalPaths,
			};
		}
		const quarantine = new QuarantineManager({
			workspaceRoot: this.requestedWorkspaceRoot,
			journal: options.mutationJournal,
			syncTargetArtifacts: !durablePackEnabled,
		});

		const mutationContext: MutationContext = {
			phase: "apply",
			ordinal: 0,
			sourceManifestId: current.manifestId,
			targetManifestId: target.manifestId,
			sourcePaths: currentPaths,
			targetPaths,
			plannedDeletePaths: new Set(plan.deletePaths),
			sourceIgnoredPaths: ignoredWorkspacePaths(current),
			mutationJournal: options.mutationJournal,
			quarantine,
		};
		try {
			await this.deletePlannedPaths(
				target.manifestId,
				targetPaths,
				plan.deletePaths,
				mutationContext,
			);
			await this.writePlannedPaths(target.manifestId, targetPaths, plan.writePaths, mutationContext);

			const topologyAfter = await this.discovery.discover(this.workspaceRoot, "restore-post");
			assertUnchangedTopology(topologyBefore, topologyAfter);
			await this.assertCompleteVisibleSubset(
				topologyAfter,
				[target],
				options.mutationJournal,
				{
					topologyValidated: true,
					scopePaths: plan.scopePaths,
					ownedPaths: [targetPaths],
				},
			);
			const verification = await this.verifyTarget(
				target,
				currentPaths,
				targetPaths,
				plan.deletePaths,
				plan.scopePaths,
			);
			const result: RestoreResult = {
				code: "ok",
				verifiedPaths: verification.verifiedPaths,
				totalPaths: verification.totalPaths,
				postFingerprint: postFingerprint(target.manifestId, topologyAfter, verification.pathFingerprints),
			};
			return await this.mutationsAreClean(options.mutationJournal)
				? result
				: { code: "recovery_required", verifiedPaths: 0, totalPaths: verification.totalPaths };
		} catch (error) {
			if (isUnconfirmedExit(error)) throw error;
			return withRecoveryBudget(async () => {
				if (!await this.restorePendingMutations(mutationContext.quarantine, options.mutationJournal)) {
					return { code: "recovery_required", verifiedPaths: 0, totalPaths: currentPaths.size };
				}
				const result = await this.rollback(
					current, target, topologyBefore, currentPaths, targetPaths, options, plan.scopePaths, !durablePackEnabled,
				);
				return { ...result, failureCode: operationFailure(error) };
			});
		}
	}

	private canUseNativeFilePlan(
		plan: RestorePlan,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
	): boolean {
		if (plan.deletePaths.length + plan.writePaths.length === 0) return false;
		if (process.platform === "win32" && plan.deletePaths.length > 0) return false;
		if (!plan.deletePaths.every((path) =>
			currentPaths.get(path)?.entry.kind === "file" && targetPaths.get(path) === undefined)) return false;
		if (!plan.writePaths.every((path) =>
			targetPaths.get(path)?.entry.kind === "file" &&
			(currentPaths.get(path) === undefined || currentPaths.get(path)?.entry.kind === "file"))) return false;
		// 与 helper 的句柄上限一致；目录创建、类型替换及过多父目录继续使用 TypeScript。
		const parents = new Set([...plan.deletePaths, ...plan.writePaths].flatMap(strictPathAncestors));
		return process.platform === "win32" || parents.size <= 128;
	}

	private async applyNativeFilePlan(
		plan: RestorePlan,
		current: SnapshotManifest,
		target: SnapshotManifest,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		topologyBefore: RootTopology,
		options: RestoreApplyOptions,
		pack: DurablePack,
		nativeRun: (pack: DurablePack) => Promise<void>,
	): Promise<RestoreResult> {
		try {
			await nativeRun(pack);
			const topologyAfter = await this.discovery.discover(this.workspaceRoot, "restore-post");
			assertUnchangedTopology(topologyBefore, topologyAfter);
			await this.assertCompleteVisibleSubset(
				topologyAfter,
				[target],
				options.mutationJournal,
				{
					topologyValidated: true,
					extraExclusions: pack.paths().flatMap((path) => {
						const artifacts = pack.artifacts(path);
						return artifacts === undefined
							? []
							: [artifacts.source, ...(artifacts.target === null ? [] : [artifacts.target])];
					}),
					scopePaths: plan.scopePaths,
					ownedPaths: [targetPaths],
				},
			);
			const totalPaths = plan.deletePaths.length + plan.writePaths.length;
			if ((await options.mutationJournal.load()).length !== 0) {
				return { code: "recovery_required", verifiedPaths: 0, totalPaths };
			}
			return { code: "ok", verifiedPaths: totalPaths, totalPaths };
		} catch (error) {
			if (isUnconfirmedExit(error)) throw error;
			return withRecoveryBudget(async () => {
				const packedRecovery = await recoverPackedMutations({
					workspaceRoot: this.workspaceRoot,
					journal: options.mutationJournal,
					planDigest: plan.planDigest,
					decision: "rollback",
				});
				if (packedRecovery.kind !== "clean") {
					return { code: "recovery_required", verifiedPaths: 0, totalPaths: plan.deletePaths.length + plan.writePaths.length };
				}
				const result = await this.rollback(
					current, target, topologyBefore, currentPaths, targetPaths, options, plan.scopePaths, false,
				);
				return { ...result, failureCode: operationFailure(error) };
			});
		}
	}

	private async durablePackEntries(
		current: SnapshotManifest,
		target: SnapshotManifest,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		plan: RestorePlan,
		opId: string,
	): Promise<DurablePackEntryInput[]> {
		const paths = [...new Set([...plan.deletePaths, ...plan.writePaths])].sort(comparePaths);
		const useValidatedBatch = SnapshotStore.supportsValidatedBlobBatch(this.store);
		const [currentBlobBytes, targetBlobBytes] = useValidatedBatch
			? await allCompleted([
				this.readDurableBlobBytes(current.manifestId, paths, currentPaths),
				this.readDurableBlobBytes(target.manifestId, paths, targetPaths),
			])
			: [new Map<string, Uint8Array>(), new Map<string, Uint8Array>()];
		const result: DurablePackEntryInput[] = [];
		for (const path of paths) {
			const variants = new Map<string, DurableLeafInput>();
			const absent: DurableLeafInput = { kind: "absent", fingerprint: fingerprintAbsent(path) };
			variants.set(absent.fingerprint, absent);
			const currentLeaf = useValidatedBatch
				? this.durableLeaf(currentPaths.get(path), currentBlobBytes.get(path))
				: await this.durableLeafCompatible(current.manifestId, currentPaths.get(path));
			if (currentLeaf !== undefined) variants.set(currentLeaf.fingerprint, currentLeaf);
			const targetLeaf = useValidatedBatch
				? this.durableLeaf(targetPaths.get(path), targetBlobBytes.get(path))
				: await this.durableLeafCompatible(target.manifestId, targetPaths.get(path));
			if (targetLeaf !== undefined) variants.set(targetLeaf.fingerprint, targetLeaf);
			if (currentLeaf === undefined && targetLeaf === undefined) continue;
			const artifactId = checksum(canonicalJson({ opId, path })).slice(0, 32);
			const parts = path.split("/");
			const parent = parts.slice(0, -1).join("/");
			const artifact = (role: "source" | "target"): string =>
				`${parent === "" ? "" : `${parent}/`}.pi-undo-q2-${artifactId}-${role}`;
			result.push({
				path,
				sourceArtifact: artifact("source"),
				targetArtifact: targetLeaf?.kind === "file" ? artifact("target") : null,
				sourceFingerprint: currentLeaf?.fingerprint ?? absent.fingerprint,
				targetFingerprint: targetLeaf?.fingerprint ?? absent.fingerprint,
				variants: [...variants.values()],
			});
		}
		return result;
	}

	private async readDurableBlobBytes(
		manifestId: ManifestId,
		paths: readonly string[],
		ownedPaths: ReadonlyMap<string, OwnedPath>,
	): Promise<ReadonlyMap<string, Uint8Array>> {
		const files = paths.flatMap((path) => {
			const owned = ownedPaths.get(path);
			if (owned?.entry.kind !== "file") return [];
			if (owned.entry.blobId === null) {
				throw new Error(`durable pack 普通文件缺少 blob：${owned.absolutePath}`);
			}
			return [{ path, owned, blobId: owned.entry.blobId }];
		});
		if (files.length === 0) return new Map();
		const requests = files.map(({ owned, blobId }) => ({
			rootPath: owned.root.relativeRoot,
			blobId,
			relativePath: owned.entry.relativePath,
		}));
		const blobs = await SnapshotStore.readBlobs(this.store, manifestId, requests);
		if (blobs.length !== files.length) throw new Error("durable pack blob batch 数量不匹配");
		return new Map(files.map(({ path }, index) => [path, blobs[index]!]));
	}

	private async durableLeafCompatible(
		manifestId: ManifestId,
		owned: OwnedPath | undefined,
	): Promise<DurableLeafInput | undefined> {
		if (owned?.entry.kind !== "file") return this.durableLeaf(owned, undefined);
		if (owned.entry.blobId === null) {
			throw new Error(`durable pack 普通文件缺少 blob：${owned.absolutePath}`);
		}
		return this.durableLeaf(owned, await this.store.readBlob(
			manifestId,
			owned.root.relativeRoot,
			owned.entry.blobId,
			owned.entry.relativePath,
		));
	}

	private durableLeaf(
		owned: OwnedPath | undefined,
		bytes: Uint8Array | undefined,
	): DurableLeafInput | undefined {
		if (owned === undefined || owned.entry.kind === "directory") return undefined;
		if (owned.entry.kind === "symlink") {
			return {
				kind: "symlink",
				fingerprint: fingerprintSymlink(owned.absolutePath, owned.entry.linkText!),
				linkText: owned.entry.linkText!,
			};
		}
		if (owned.entry.blobId === null || bytes === undefined) {
			throw new Error(`durable pack 普通文件缺少 blob：${owned.absolutePath}`);
		}
		const mode = owned.entry.mode & 0o777;
		return {
			kind: "file",
			fingerprint: fingerprintBytes(owned.absolutePath, bytes, mode),
			mode,
			bytes,
		};
	}

	private async readOwnedPaths(
		manifest: SnapshotManifest,
		scopePaths?: readonly string[],
	): Promise<Map<string, OwnedPath>> {
		const result = new Map<string, OwnedPath>();
		for (const root of manifest.roots) {
			assertNotGitMetadata(root.relativeRoot);
			const rootScope = rootRelativeScopePaths(root.relativeRoot, scopePaths);
			if (rootScope !== undefined && rootScope.length === 0) continue;
			const entries = await this.store.listTree(manifest.manifestId, root.relativeRoot, rootScope);
			if (entries.length > 0) {
				for (const boundaryPath of rootBoundaryDirectories(root.relativeRoot)) {
					if (!result.has(boundaryPath)) {
						result.set(boundaryPath, {
							absolutePath: boundaryPath,
							entry: {
								relativePath: boundaryPath,
								kind: "directory",
								mode: 0o755,
								blobId: null,
								size: 0,
								rootHash: root.treeId ?? root.objectClosure,
							},
							root,
						});
					}
				}
			}
			for (const entry of entries) {
				const absolutePath = workspacePath(root.relativeRoot, entry.relativePath);
				assertNotGitMetadata(absolutePath);
				relativeSafePath(this.workspaceRoot, absolutePath);
				if (result.has(absolutePath)) {
					throw new Error(`restore path 被多个 root 覆盖：${absolutePath}`);
				}
				result.set(absolutePath, { absolutePath, entry, root });
			}
		}
		return result;
	}

	private async prefetchCompleteRestoreBlobs(
		plan: RestorePlan,
		current: SnapshotManifest,
		target: SnapshotManifest,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
	): Promise<void> {
		if (plan.scopePaths !== undefined || !SnapshotStore.supportsValidatedBlobBatch(this.store)) return;
		const requestsFor = (paths: ReadonlyMap<string, OwnedPath>, extraPaths: readonly string[] = []) => {
			const requests = [];
			const requested = new Set([...plan.writePaths, ...extraPaths]);
			for (const path of requested) {
				const owned = paths.get(path);
				if (owned === undefined || owned.entry.kind !== "file" || owned.entry.blobId === null) continue;
				requests.push({
					rootPath: owned.root.relativeRoot,
					blobId: owned.entry.blobId,
					relativePath: owned.entry.relativePath,
				});
			}
			return requests;
		};
		await allCompleted([
			this.store.prefetchBlobs(current.manifestId, requestsFor(currentPaths, plan.deletePaths)),
			this.store.prefetchBlobs(target.manifestId, requestsFor(targetPaths)),
		]);
	}

	private assertCurrentTopology(
		current: SnapshotManifest,
		target: SnapshotManifest,
		actual: RootTopology,
	): void {
		if (!sameTopologyModuloIdentity(actual, current)) {
			throw new Error("apply 前 workspace topology 与 current manifest 不一致");
		}
		const currentRoots = new Map(current.roots.map((root) => [root.relativeRoot, root]));
		for (const targetRoot of target.roots) {
			const currentRoot = currentRoots.get(targetRoot.relativeRoot);
			if (currentRoot !== undefined && targetRoot.state === "active" && currentRoot.state !== "active") {
				throw new Error(`restore 不能把 inactive root 物化为 active：${targetRoot.relativeRoot}`);
			}
		}
	}

	private async verifyKnownState(
		current: SnapshotManifest,
		target: SnapshotManifest,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		scopePaths?: readonly string[],
	): Promise<{ ok: boolean; verifiedPaths: number; totalPaths: number }> {
		const scope = scopePaths === undefined ? undefined : new Set(scopePaths);
		const paths = [...new Set([...currentPaths.keys(), ...targetPaths.keys()])]
			.filter((path) => scope === undefined || scope.has(path))
			.sort(comparePaths);
		const results: Array<boolean | undefined> = new Array(paths.length);
		let nextIndex = 0;
		let stop = false;
		let failure: unknown;
		let failureIndex: number | undefined;
		const verifyPath = async (path: string): Promise<boolean> => {
			if (await this.pathIsShadowedByTarget(target.manifestId, path, targetPaths)) return true;
			const currentPath = currentPaths.get(path);
			const targetPath = targetPaths.get(path);
			const matchesCurrent = currentPath !== undefined &&
				await this.entryMatches(current.manifestId, currentPath);
			const matchesTarget = !matchesCurrent && targetPath !== undefined &&
				await this.entryMatches(target.manifestId, targetPath);
			const matchesAbsentSide = !matchesCurrent && !matchesTarget &&
				(currentPath === undefined || targetPath === undefined) &&
				await this.pathIsAbsent(path);
			return matchesCurrent || matchesTarget || matchesAbsentSide;
		};
		const worker = async (): Promise<void> => {
			while (!stop && nextIndex < paths.length) {
				const index = nextIndex;
				nextIndex += 1;
				try {
					const ok = await verifyPath(paths[index]!);
					results[index] = ok;
					if (!ok) stop = true;
				} catch (error) {
					if (failureIndex === undefined || index < failureIndex) {
						failure = error;
						failureIndex = index;
					}
					stop = true;
				}
			}
		};
		if (paths.length > 0) {
			await Promise.all(Array.from(
				{ length: Math.min(RESTORE_FILE_VERIFY_CONCURRENCY, paths.length) },
				() => worker(),
			));
		}
		let verifiedPaths = 0;
		for (let index = 0; index < results.length; index += 1) {
			const ok = results[index];
			if (ok === false) return { ok: false, verifiedPaths, totalPaths: paths.length };
			if (ok === undefined) {
				if (failureIndex === index && failure !== undefined) throw failure;
				return { ok: false, verifiedPaths, totalPaths: paths.length };
			}
			verifiedPaths += 1;
		}
		return { ok: true, verifiedPaths, totalPaths: paths.length };
	}

	private async deletePlannedPaths(
		targetManifestId: ManifestId,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		deletePaths: readonly string[],
		context: MutationContext,
	): Promise<void> {
		let fileBatch: OwnedPath[] = [];
		let fileBatchRoot: string | undefined;
		const flushFiles = async (): Promise<void> => {
			if (fileBatch.length === 0) return;
			const requests: DeleteLeafRequest[] = [];
			for (const source of fileBatch) {
				context.ordinal += 1;
				const ordinal = context.ordinal;
				await this.beforeMutation?.({
					phase: context.phase,
					ordinal,
					kind: "delete",
					path: source.absolutePath,
				});
				await this.assertMutationPath(source.absolutePath);
				await this.assertMutationState(context, "delete", source.absolutePath);
				requests.push({
					path: source.absolutePath,
					sourceFingerprint: await this.expectedMutationFingerprint(context, source.absolutePath),
					targetFingerprint: fingerprintAbsent(source.absolutePath),
				});
			}
			await context.quarantine.deleteFiles(requests);
			fileBatch = [];
			fileBatchRoot = undefined;
		};
		for (const path of deletePaths) {
			checkOperation();
			if (await this.pathIsShadowedByTarget(targetManifestId, path, targetPaths)) continue;
			const source = context.sourcePaths.get(path);
			const live = await lstat(this.absolutePath(path)).catch((error) => {
				if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return null;
				throw error;
			});
			if (live === null) continue;
			if (source?.entry.kind !== "file" || live.isSymbolicLink() || !live.isFile()) {
				await flushFiles();
				await this.deletePath(path, context);
				continue;
			}
			if (
				fileBatch.length > 0 &&
				(fileBatchRoot !== source.root.relativeRoot || fileBatch.length >= RESTORE_FILE_BATCH_MAX_ENTRIES)
			) {
				await flushFiles();
			}
			fileBatch.push(source);
			fileBatchRoot = source.root.relativeRoot;
		}
		await flushFiles();
	}

	private async deletePath(path: string, context: MutationContext): Promise<void> {
		const absolutePath = this.absolutePath(path);
		try {
			await this.assertMutationPath(path);
		} catch (error) {
			if (hasErrorCode(error, "unsafe_path")) {
				try {
					await lstat(absolutePath);
				} catch (pathError) {
					if (hasErrorCode(pathError, "ENOTDIR")) {
						return;
					}
				}
			}
			throw error;
		}
		const metadata = await lstat(absolutePath).catch((error) => {
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return null;
			throw error;
		});
		if (metadata === null) {
			return;
		}
		if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
			await this.mutate(context, "delete", path, async () => {
				await rmdir(absolutePath).catch((error) => {
					if (!hasErrorCode(error, "ENOTEMPTY") && !hasErrorCode(error, "EEXIST")) {
						throw error;
					}
				});
			});
			return;
		}
		await this.mutate(context, "delete", path, async () => {
			const record = await context.quarantine.deleteLeaf({
				path,
				sourceFingerprint: await this.expectedMutationFingerprint(context, path),
				targetFingerprint: fingerprintAbsent(path),
			});
			await context.quarantine.cleanupMutation(record);
		});
	}

	private async writePath(
		manifestId: ManifestId,
		target: OwnedPath,
		context: MutationContext,
	): Promise<void> {
		const path = target.absolutePath;
		if (target.entry.kind === "directory") {
			const metadata = await lstat(this.absolutePath(path)).catch((error) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (metadata !== null) {
				if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
					throw new Error(`目录骨架存在类型冲突：${path}`);
				}
				return;
			}
			await this.mutate(context, "mkdir", path, () => mkdir(this.absolutePath(path)));
			return;
		}

		if (target.entry.kind === "symlink") {
			const linkText = target.entry.linkText;
			if (linkText === undefined || Buffer.from(linkText, "utf8").toString("utf8") !== linkText) {
				throw new Error(`symlink target 无法安全表示：${path}`);
			}
			const absolutePath = this.absolutePath(path);
			const metadata = await lstat(absolutePath).catch((error) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (metadata !== null) {
				if (metadata.isSymbolicLink() && await readlink(absolutePath) === linkText) {
					return;
				}
				throw new Error(`symlink 存在类型或内容冲突：${path}`);
			}
			await this.mutate(context, "symlink", path, async (beforeInstall) => {
				const record = await context.quarantine.replaceSymlink({
					path,
					targetLinkText: linkText,
					sourceFingerprint: await this.expectedMutationFingerprint(context, path),
					targetFingerprint: fingerprintSymlink(path, linkText),
					beforeInstall,
				});
				await context.quarantine.cleanupMutation(record);
			}, true);
			return;
		}

		if (target.entry.blobId === null) {
			throw new Error(`普通文件缺少 blob：${path}`);
		}
		const bytes = await this.store.readBlob(
			manifestId,
			target.root.relativeRoot,
			target.entry.blobId,
			target.entry.relativePath,
		);
		if (bytes.byteLength !== target.entry.size) {
			throw new Error(`普通文件 blob 大小不匹配：${path}`);
		}
		await this.mutate(
			context,
			"write",
			path,
			async (beforeInstall) => {
				const record = await context.quarantine.replaceFile({
					path,
					targetBytes: bytes,
					targetMode: target.entry.mode & 0o777,
					sourceFingerprint: await this.expectedMutationFingerprint(context, path),
					targetFingerprint: fingerprintBytes(path, bytes, target.entry.mode),
					beforeInstall,
				});
				await context.quarantine.cleanupMutation(record);
			},
			true,
		);
	}

	private async rollback(
		current: SnapshotManifest,
		target: SnapshotManifest,
		topologyBefore: RootTopology,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		options: RestoreApplyOptions,
		scopePaths: readonly string[] | undefined,
		syncTargetArtifacts: boolean,
	): Promise<RestoreResult> {
		let rollbackPlan: RestorePlan | undefined;
		try {
			rollbackPlan = await this.plan(target, current, scopePaths);
			const context: MutationContext = {
				phase: "rollback",
				ordinal: 0,
				sourceManifestId: target.manifestId,
				targetManifestId: current.manifestId,
				sourcePaths: targetPaths,
				targetPaths: currentPaths,
				plannedDeletePaths: new Set(rollbackPlan.deletePaths),
				sourceIgnoredPaths: ignoredWorkspacePaths(target),
				mutationJournal: options.mutationJournal,
				quarantine: new QuarantineManager({
					workspaceRoot: this.requestedWorkspaceRoot,
					journal: options.mutationJournal,
					syncTargetArtifacts,
				}),
			};
			await this.deletePlannedPaths(
				current.manifestId,
				currentPaths,
				rollbackPlan.deletePaths,
				context,
			);
			await this.writePlannedPaths(current.manifestId, currentPaths, rollbackPlan.writePaths, context);
			const topologyAfter = await this.discovery.discover(this.workspaceRoot, "restore-post");
			assertUnchangedTopology(topologyBefore, topologyAfter);
			await this.assertCompleteVisibleSubset(
				topologyAfter,
				[current],
				options.mutationJournal,
				{
					topologyValidated: true,
					scopePaths,
					ownedPaths: [currentPaths],
				},
			);
			const verification = await this.verifyTarget(
				current,
				targetPaths,
				currentPaths,
				rollbackPlan.deletePaths,
				rollbackPlan.scopePaths,
			);
			const result: RestoreResult = {
				code: "restore_failed_safe",
				verifiedPaths: verification.verifiedPaths,
				totalPaths: verification.totalPaths,
				postFingerprint: postFingerprint(
					current.manifestId,
					topologyAfter,
					verification.pathFingerprints,
				),
			};
			return await this.mutationsAreClean(options.mutationJournal)
				? result
				: { code: "recovery_required", verifiedPaths: 0, totalPaths: verification.totalPaths };
		} catch {
			const pendingRestored = await this.restorePendingMutations(
				new QuarantineManager({
					workspaceRoot: this.requestedWorkspaceRoot,
					journal: options.mutationJournal,
					syncTargetArtifacts,
				}),
				options.mutationJournal,
			);
			if (!pendingRestored) {
				return { code: "recovery_required", verifiedPaths: 0, totalPaths: currentPaths.size };
			}
			if (rollbackPlan !== undefined) {
				try {
					const topologyAfter = await this.discovery.discover(this.workspaceRoot, "compensation");
					assertUnchangedTopology(topologyBefore, topologyAfter);
					await this.assertCompleteVisibleSubset(
						topologyAfter,
						[current],
						options.mutationJournal,
						{
							topologyValidated: true,
							scopePaths,
							ownedPaths: [currentPaths],
						},
					);
					const verification = await this.verifyTarget(
						current,
						targetPaths,
						currentPaths,
						rollbackPlan.deletePaths,
						rollbackPlan.scopePaths,
					);
					const result: RestoreResult = {
						code: "restore_failed_safe",
						verifiedPaths: verification.verifiedPaths,
						totalPaths: verification.totalPaths,
						postFingerprint: postFingerprint(
							current.manifestId,
							topologyAfter,
							verification.pathFingerprints,
						),
					};
					return await this.mutationsAreClean(options.mutationJournal)
						? result
						: { code: "recovery_required", verifiedPaths: 0, totalPaths: verification.totalPaths };
				} catch {
					// 完整 current 状态仍不可证明，继续返回保守的 partial/recovery 结果。
				}
			}
			let verifiedPaths = 0;
			const scope = scopePaths === undefined ? undefined : new Set(scopePaths);
			for (const [path, owned] of currentPaths) {
				if (scope !== undefined && !scope.has(path)) continue;
				try {
					await this.verifyEntry(current.manifestId, owned);
					verifiedPaths += 1;
				} catch {
					// rollback 已失败，只统计仍可证明安全的路径。
				}
			}
			return {
				code: verifiedPaths > 0 ? "partial_restore" : "recovery_required",
				verifiedPaths,
				totalPaths: scope === undefined ? currentPaths.size : scope.size,
			};
		}
	}

	private async mutate(
		context: MutationContext,
		kind: RestoreMutation["kind"],
		path: string,
		mutation: (beforeInstall: () => Promise<void>) => Promise<void>,
		deferHook = false,
	): Promise<void> {
		context.ordinal += 1;
		const ordinal = context.ordinal;
		const beforeInstall = async (): Promise<void> => {
			checkOperation();
			await this.beforeMutation?.({ phase: context.phase, ordinal, kind, path });
			checkOperation();
		};
		if (!deferHook) await beforeInstall();
		await this.assertMutationPath(path);
		await this.assertMutationState(context, kind, path);
		await mutation(deferHook ? beforeInstall : async () => {});
	}

	private async writePlannedPaths(
		manifestId: ManifestId,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		writePaths: readonly string[],
		context: MutationContext,
	): Promise<void> {
		let fileBatch: OwnedPath[] = [];
		let fileBatchBytes = 0;
		let fileBatchRoot: string | undefined;
		const flushFiles = async (): Promise<void> => {
			if (fileBatch.length === 0) return;
			const pending = fileBatch.map((target) => {
				context.ordinal += 1;
				return { target, ordinal: context.ordinal };
			});
			const requests = await mapConcurrentOrdered(
				pending,
				RESTORE_FILE_PREPARE_CONCURRENCY,
				({ target, ordinal }) => this.prepareFileReplacement(manifestId, target, context, ordinal),
			);
			await context.quarantine.replaceFiles(requests);
			fileBatch = [];
			fileBatchBytes = 0;
			fileBatchRoot = undefined;
		};
		for (const kind of ["directory", "leaf"] as const) {
			for (const path of writePaths) {
				checkOperation();
				const target = targetPaths.get(path);
				if (target === undefined) {
					throw new Error(`${context.phase} plan 引用了 manifest 外路径：${path}`);
				}
				if ((target.entry.kind === "directory") !== (kind === "directory")) continue;
				if (context.sourceIgnoredPaths.has(path)) {
					await flushFiles();
					if (await this.entryMatches(manifestId, target)) continue;
					throw new Error(`${context.phase} 的 ignored-present 路径与目标内容冲突：${path}`);
				}
				if (target.entry.kind !== "file") {
					await flushFiles();
					await this.writePath(manifestId, target, context);
					continue;
				}
				if (
					fileBatch.length > 0 &&
					(fileBatchRoot !== target.root.relativeRoot ||
						fileBatch.length >= RESTORE_FILE_BATCH_MAX_ENTRIES ||
						fileBatchBytes + target.entry.size > RESTORE_FILE_BATCH_MAX_BYTES)
				) {
					await flushFiles();
				}
				fileBatch.push(target);
				fileBatchBytes += target.entry.size;
				fileBatchRoot = target.root.relativeRoot;
			}
			await flushFiles();
		}
	}

	private async prepareFileReplacement(
		manifestId: ManifestId,
		target: OwnedPath,
		context: MutationContext,
		ordinal: number,
	): Promise<ReplaceFileRequest> {
		if (target.entry.kind !== "file" || target.entry.blobId === null) {
			throw new Error(`批量普通文件缺少 blob：${target.absolutePath}`);
		}
		const bytes = await this.store.readBlob(
			manifestId,
			target.root.relativeRoot,
			target.entry.blobId,
			target.entry.relativePath,
		);
		if (bytes.byteLength !== target.entry.size) {
			throw new Error(`普通文件 blob 大小不匹配：${target.absolutePath}`);
		}
		await this.assertMutationPath(target.absolutePath);
		await this.assertMutationState(context, "write", target.absolutePath);
		return {
			path: target.absolutePath,
			targetBytes: bytes,
			targetMode: target.entry.mode & 0o777,
			sourceFingerprint: await this.expectedMutationFingerprint(context, target.absolutePath),
			targetFingerprint: fingerprintBytes(target.absolutePath, bytes, target.entry.mode),
			...(this.beforeMutation === undefined ? {} : {
				beforeInstall: async () => {
					checkOperation();
					await this.beforeMutation?.({
						phase: context.phase,
						ordinal,
						kind: "write",
						path: target.absolutePath,
					});
				},
			}),
		};
	}

	private async assertMutationState(
		context: MutationContext,
		kind: RestoreMutation["kind"],
		path: string,
	): Promise<void> {
		if (
			kind === "delete" &&
			(await this.pathIsShadowedByTarget(context.targetManifestId, path, context.targetPaths) ||
				await this.pathIsShadowedByTarget(context.sourceManifestId, path, context.sourcePaths))
		) {
			return;
		}
		const source = context.sourcePaths.get(path);
		if (source !== undefined && await this.entryMatches(context.sourceManifestId, source)) {
			return;
		}
		const target = context.targetPaths.get(path);
		if (target !== undefined && await this.entryMatches(context.targetManifestId, target)) {
			return;
		}
		if (await this.pathIsAbsent(path)) {
			if (kind === "delete" || source === undefined || context.plannedDeletePaths.has(path)) {
				return;
			}
		}
		throw new Error(`${context.phase} mutation 前路径不再处于已知状态：${path}`);
	}

	private async assertCompleteVisibleSubset(
		topology: RootTopology,
		allowedManifests: readonly SnapshotManifest[],
		mutationJournal: MutationJournal | undefined,
		check: VisibleSubsetCheck,
	): Promise<void> {
		if (allowedManifests.some((manifest) => manifest.coverage !== "complete")) {
			return;
		}
		const allowedPaths = new Set<string>();
		for (const [index, manifest] of allowedManifests.entries()) {
			for (const path of ignoredWorkspacePaths(manifest, check.scopePaths)) {
				allowedPaths.add(path);
			}
			const paths = check.ownedPaths?.[index] ?? await this.readOwnedPaths(manifest, check.scopePaths);
			for (const [path, owned] of paths) {
				if (owned.entry.kind !== "directory") {
					allowedPaths.add(path);
				}
			}
		}

		const exclusions = new Set(check.extraExclusions ?? []);
		if (mutationJournal !== undefined) {
			for (const path of await mutationJournal.activeArtifacts()) exclusions.add(path);
		}
		const livePaths = await this.store.listVisibleLeafPaths(topology, {
			excludePaths: exclusions.size === 0 ? undefined : [...exclusions],
			includePaths: check.scopePaths,
			topologyAlreadyValidated: check.topologyValidated,
		});
		for (const path of livePaths) {
			if (!allowedPaths.has(path)) {
				throw new Error(`complete coverage 发现 manifest 集合外路径：${path}`);
			}
		}
	}

	private async verifyTarget(
		target: SnapshotManifest,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		deletePaths: readonly string[],
		scopePaths?: readonly string[],
	): Promise<{ verifiedPaths: number; totalPaths: number; pathFingerprints: string[] }> {
		const scope = scopePaths === undefined ? undefined : new Set(scopePaths);
		const scopedTargets = [...targetPaths].filter(([path]) => scope === undefined || scope.has(path));
		const pathFingerprints = await mapConcurrentOrdered(
			scopedTargets,
			RESTORE_FILE_VERIFY_CONCURRENCY,
			([, owned]) => this.verifyEntry(target.manifestId, owned),
		);
		const remainingDeletes = deletePaths.filter((path) =>
			!targetPaths.has(path) &&
			currentPaths.get(path)?.entry.kind !== "directory" &&
			!hasNonDirectoryAncestor(path, targetPaths));
		await mapConcurrentOrdered(remainingDeletes, RESTORE_FILE_VERIFY_CONCURRENCY, async (path) => {
			try {
				await lstat(this.absolutePath(path));
				throw new Error(`目标应删除的路径仍然存在：${path}`);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					throw error;
				}
			}
		});
		return {
			verifiedPaths: pathFingerprints.length + remainingDeletes.length,
			totalPaths: pathFingerprints.length + remainingDeletes.length,
			pathFingerprints,
		};
	}

	private async entryMatches(manifestId: ManifestId, owned: OwnedPath): Promise<boolean> {
		try {
			await this.verifyEntry(manifestId, owned);
			return true;
		} catch {
			return false;
		}
	}

	private async pathIsAbsent(path: string): Promise<boolean> {
		try {
			await lstat(this.absolutePath(path));
			return false;
		} catch (error) {
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
				return true;
			}
			throw error;
		}
	}

	private async expectedMutationFingerprint(context: MutationContext, path: string): Promise<string> {
		for (const [manifestId, owned] of [
			[context.sourceManifestId, context.sourcePaths.get(path)],
			[context.targetManifestId, context.targetPaths.get(path)],
		] as const) {
			if (owned === undefined || owned.entry.kind === "directory") continue;
			if (!await this.entryMatches(manifestId, owned)) continue;
			if (owned.entry.kind === "symlink") {
				return fingerprintSymlink(path, owned.entry.linkText!);
			}
			if (owned.entry.blobId === null) throw new Error(`普通文件缺少 blob：${path}`);
			const bytes = await this.store.readBlob(
				manifestId,
				owned.root.relativeRoot,
				owned.entry.blobId,
				owned.entry.relativePath,
			);
			return fingerprintBytes(path, bytes, owned.entry.mode);
		}
		if (await this.pathIsAbsent(path)) return fingerprintAbsent(path);
		throw new Error(`mutation 前路径不再处于已知叶子状态：${path}`);
	}

	private async mutationsAreClean(journal: MutationJournal): Promise<boolean> {
		try {
			await journal.assertCleaned();
			return true;
		} catch {
			return false;
		}
	}

	private async restorePendingMutations(
		quarantine: QuarantineManager,
		journal: MutationJournal,
	): Promise<boolean> {
		try {
			for (const record of [...await journal.load()].reverse()) {
				if (record.state !== "CLEANED") await quarantine.restoreMutation(record);
			}
			await journal.assertCleaned();
			return true;
		} catch {
			return false;
		}
	}

	private async pathIsShadowedByTarget(
		manifestId: ManifestId,
		path: string,
		targetPaths: ReadonlyMap<string, OwnedPath>,
	): Promise<boolean> {
		for (const ancestor of strictPathAncestors(path)) {
			const target = targetPaths.get(ancestor);
			if (target !== undefined && target.entry.kind !== "directory") {
				return this.entryMatches(manifestId, target);
			}
		}
		return false;
	}

	private async verifyEntry(manifestId: ManifestId, owned: OwnedPath): Promise<string> {
		const path = owned.absolutePath;
		await assertNoSymlinkEscape(this.workspaceRoot, path);
		const metadata = await lstat(this.absolutePath(path));
		if (owned.entry.kind === "directory") {
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`目录类型校验失败：${path}`);
			}
			return checksum(canonicalJson({ path, kind: "directory" }));
		}
		if (owned.entry.kind === "symlink") {
			if (!metadata.isSymbolicLink() || await readlink(this.absolutePath(path)) !== owned.entry.linkText) {
				throw new Error(`symlink 校验失败：${path}`);
			}
			return checksum(canonicalJson({ path, kind: "symlink", linkText: owned.entry.linkText }));
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(`普通文件类型校验失败：${path}`);
		}
		if ((metadata.mode & 0o111) !== (owned.entry.mode & 0o111)) {
			throw new Error(`普通文件 mode 校验失败：${path}`);
		}
		if (owned.entry.blobId === null) {
			throw new Error(`普通文件缺少 blob：${path}`);
		}
		const [actual, expected] = await allCompleted([
			readFile(this.absolutePath(path)),
			this.store.readBlob(
				manifestId,
				owned.root.relativeRoot,
				owned.entry.blobId,
				owned.entry.relativePath,
			),
		]);
		if (!actual.equals(Buffer.from(expected))) {
			throw new Error(`普通文件内容校验失败：${path}`);
		}
		return checksum(canonicalJson({
			path,
			kind: "file",
			mode: owned.entry.mode,
			blobId: owned.entry.blobId,
		}));
	}

	private async assertMutationPath(path: string): Promise<void> {
		await this.assertWorkspaceRootIdentity();
		assertNotGitMetadata(path);
		relativeSafePath(this.workspaceRoot, path);
		await assertNoSymlinkEscape(this.workspaceRoot, path);
	}

	private async assertWorkspaceRootIdentity(): Promise<string> {
		const [requestedIdentity, workspaceIdentity] = await Promise.all([
			realpath(this.requestedWorkspaceRoot),
			realpath(this.workspaceRoot),
		]);
		if (requestedIdentity !== this.workspaceRoot || workspaceIdentity !== this.workspaceRoot) {
			throw new Error("restore workspace root identity 已变化");
		}
		return workspaceIdentity;
	}

	private absolutePath(path: string): string {
		return join(this.workspaceRoot, ...path.split("/"));
	}

	private canonicalScope(paths: readonly string[]): ReadonlySet<string> {
		const canonical = [...new Set(paths)].sort(comparePaths);
		for (const path of canonical) {
			assertNotGitMetadata(path);
			relativeSafePath(this.workspaceRoot, path);
		}
		return new Set(canonical);
	}
}

function preparedPlanKey(plan: RestorePlan): string {
	return `${plan.currentManifestId}\0${plan.targetManifestId}\0${plan.planDigest}`;
}

function cloneRestorePlan(plan: RestorePlan): RestorePlan {
	return {
		currentManifestId: plan.currentManifestId,
		targetManifestId: plan.targetManifestId,
		boundaryRoots: [...plan.boundaryRoots],
		deletePaths: [...plan.deletePaths],
		writePaths: [...plan.writePaths],
		...(plan.scopePaths === undefined ? {} : { scopePaths: [...plan.scopePaths] }),
		planDigest: plan.planDigest,
	};
}

function sameEntry(left: RestorePath, right: RestorePath): boolean {
	return left.kind === right.kind &&
		left.mode === right.mode &&
		left.blobId === right.blobId &&
		left.size === right.size &&
		left.linkText === right.linkText;
}

// sourceIdentity/privateRepositoryId 会随 git remote 配置漂移（例如后来补充 remote origin），
// 它们是仓库元数据而非工作区内容；restore 的内容安全由逐文件校验
// （verifyKnownState、assertCompleteVisibleSubset、verifyTarget）保证。
// 因此这里只比较结构性拓扑字段：root 集合、parentRoot、state 与 gitlinkOid。
function sameTopologyModuloIdentity(actual: RootTopology, expected: SnapshotManifest): boolean {
	if (actual.workspaceIdentity !== expected.workspaceIdentity) return false;
	const expectedRoots = new Map(expected.roots.map((root) => [root.relativeRoot, root]));
	if (actual.roots.length !== expectedRoots.size) return false;
	for (const root of actual.roots) {
		const expectedRoot = expectedRoots.get(root.relativeRoot);
		if (
			expectedRoot === undefined ||
			expectedRoot.parentRoot !== root.parentRoot ||
			expectedRoot.state !== root.state ||
			(expectedRoot.gitlinkOid ?? null) !== (root.gitlinkOid ?? null)
		) {
			return false;
		}
	}
	return true;
}

function assertCompatibleManifests(
	current: SnapshotManifest,
	target: SnapshotManifest,
	scope?: ReadonlySet<string>,
): void {
	if (current.workspaceIdentity !== target.workspaceIdentity) {
		throw new Error("restore manifest 不属于同一 workspace");
	}
	if (current.roots.some((root) => root.state === "broken") || target.roots.some((root) => root.state === "broken")) {
		const brokenRoots = [...current.roots, ...target.roots]
			.filter((root, index, all) => root.state === "broken" && all.findIndex((candidate) => candidate.relativeRoot === root.relativeRoot) === index)
			.map((root) => root.relativeRoot);
		throw new Error(`broken root 不能用于 restore: ${brokenRoots.join(", ")}`);
	}
	const scopedCoverage = scope === undefined
		? undefined
		: `paths:${checksum(canonicalJson([...scope]))}`;
	if (current.coverage === target.coverage) {
		if (
			scopedCoverage !== undefined && current.coverage !== "complete" &&
			current.coverage !== scopedCoverage
		) {
			throw new Error("restore manifest coverage 与 scope 不匹配");
		}
		return;
	}
	if (
		scopedCoverage === undefined ||
		![current.coverage, target.coverage].every(
			(coverage) => coverage === "complete" || coverage === scopedCoverage,
		)
	) {
		throw new Error("restore manifest coverage 不一致，不能推断缺失路径");
	}
}

function orderedWritePaths(
	roots: readonly SnapshotRoot[],
	paths: ReadonlyMap<string, readonly string[]>,
	targetPaths: ReadonlyMap<string, OwnedPath>,
): string[] {
	const directories = [...paths.values()].flat().filter(
		(path) => targetPaths.get(path)?.entry.kind === "directory",
	);
	const result: string[] = [];
	for (const root of roots) {
		const leaves = (paths.get(root.relativeRoot) ?? []).filter(
			(path) => targetPaths.get(path)?.entry.kind !== "directory",
		);
		result.push(...sortWritePaths(leaves));
	}
	return [...sortWritePaths(directories), ...result];
}

function appendPath(paths: Map<string, string[]>, root: string, path: string): void {
	const owned = paths.get(root);
	if (owned === undefined) {
		paths.set(root, [path]);
		return;
	}
	owned.push(path);
}

function rootRelativeScopePaths(
	root: string,
	scopePaths: readonly string[] | undefined,
): string[] | undefined {
	if (scopePaths === undefined) return undefined;
	if (scopePaths.length === 0) return [];
	const result = new Set<string>();
	for (const path of scopePaths) {
		if (path === "." || path === root || isStrictWorkspaceAncestor(path, root)) return undefined;
		if (isStrictWorkspaceAncestor(root, path)) {
			result.add(root === "." ? path : path.slice(root.length + 1));
		}
	}
	return [...result].sort(comparePaths);
}

function isStrictWorkspaceAncestor(parent: string, child: string): boolean {
	return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function workspacePath(root: string, path: string): string {
	return root === "." ? path : path === "." ? root : `${root}/${path}`;
}

function ignoredWorkspacePaths(
	manifest: SnapshotManifest,
	scopePaths?: readonly string[],
): Set<string> {
	const scope = scopePaths === undefined ? undefined : new Set(scopePaths);
	const scopeAncestors = new Set(scopePaths?.flatMap(strictPathAncestors));
	return new Set(manifest.roots.flatMap((root) =>
		root.ignoredPresentPaths
			.map((path) => workspacePath(root.relativeRoot, path))
			.filter((path) => scope === undefined || scope.has(".") || scope.has(path) ||
				scopeAncestors.has(path) || strictPathAncestors(path).some((ancestor) => scope.has(ancestor)))
	));
}

/**
 * ignored 证明的前缀索引。
 *
 * 目录判定需要回答"是否存在以 `${path}/` 开头的 ignored 路径"。逐次线性扫描
 * 整个 set 会让"目录数 × ignored 数"变成平方项，因此这里预排序一次，
 * 之后每次判定用二分下界定位第一个不小于前缀的元素。
 *
 * 语义与线性扫描完全一致：只回答存在性，不改变 fail-closed 行为，也不放宽
 * 任何 ignored 保护。非目录仍走精确 `has()`。
 */
class IgnoredProofIndex {
	private readonly exact: ReadonlySet<string>;
	private sortedPaths: readonly string[] | undefined;

	constructor(paths: ReadonlySet<string>) {
		this.exact = paths;
	}

	isProtected(path: string, kind: RestorePath["kind"]): boolean {
		if (kind !== "directory") {
			return this.exact.has(path);
		}
		if (this.exact.size === 0) return false;
		// 排序成本只在第一次目录判定时付出，纯文件计划完全不触发。
		this.sortedPaths ??= [...this.exact].sort();
		const sorted = this.sortedPaths;
		const prefix = `${path}/`;
		let low = 0;
		let high = sorted.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (sorted[middle]! < prefix) low = middle + 1;
			else high = middle;
		}
		return low < sorted.length && sorted[low]!.startsWith(prefix);
	}
}

function rootBoundaryDirectories(root: string): string[] {
	if (root === ".") {
		return [];
	}
	const parts = root.split("/");
	return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
}

function strictPathAncestors(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/")).reverse();
}

function hasNonDirectoryAncestor(path: string, paths: ReadonlyMap<string, OwnedPath>): boolean {
	return strictPathAncestors(path).some((ancestor) => {
		const owned = paths.get(ancestor);
		return owned !== undefined && owned.entry.kind !== "directory";
	});
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertNotGitMetadata(path: string): void {
	if (path.split("/").some((component) => component.toLowerCase() === ".git")) {
		throw new Error(`restore 永远不操作真实 Git metadata：${path}`);
	}
}

function assertUnchangedTopology(before: RootTopology, after: RootTopology): void {
	const rootKindsMatch = before.roots.length === after.roots.length && before.roots.every((root, index) => {
		const candidate = after.roots[index];
		return candidate !== undefined &&
			candidate.relativeRoot === root.relativeRoot &&
			candidate.gitBacked === root.gitBacked;
	});
	if (
		before.workspaceIdentity !== after.workspaceIdentity ||
		before.fingerprint !== after.fingerprint ||
		!rootKindsMatch
	) {
		throw new Error("restore 期间 workspace topology 发生变化");
	}
}

function postFingerprint(
	manifestId: ManifestId,
	topology: RootTopology,
	pathFingerprints: readonly string[],
): string {
	return checksum(canonicalJson({
		manifestId,
		topologyFingerprint: topology.fingerprint,
		paths: pathFingerprints,
	}));
}

function hasValidPlanDigest(plan: RestorePlan): boolean {
	const keys = Object.keys(plan).sort();
	const expectedKeys = [
		"boundaryRoots",
		"currentManifestId",
		"deletePaths",
		"planDigest",
		...(plan.scopePaths === undefined ? [] : ["scopePaths"]),
		"targetManifestId",
		"writePaths",
	].sort();
	if (canonicalJson(keys) !== canonicalJson(expectedKeys)) {
		return false;
	}
	try {
		return checksum(canonicalJson({
			currentManifestId: plan.currentManifestId,
			targetManifestId: plan.targetManifestId,
			boundaryRoots: plan.boundaryRoots,
			deletePaths: plan.deletePaths,
			writePaths: plan.writePaths,
			...(plan.scopePaths === undefined ? {} : { scopePaths: plan.scopePaths }),
		})) === plan.planDigest;
	} catch {
		return false;
	}
}

async function mapConcurrentOrdered<T, R>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let nextIndex = 0;
	let failed = false;
	let failure: unknown;
	async function worker(): Promise<void> {
		while (!failed && nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				checkOperation();
				results[index] = await operation(values[index]!);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
	if (failed) throw failure;
	return results;
}

function durablePairKey(
	currentManifestId: ManifestId,
	targetManifestId: ManifestId,
	scopePaths: readonly string[],
): string {
	return `${currentManifestId}\0${targetManifestId}\0${checksum(canonicalJson([...scopePaths].sort(comparePaths)))}`;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseDurableCacheIndex(value: unknown): DurableCacheIndex {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
		throw new Error("durable cache index 无效");
	}
	const entries: DurableCacheIndexEntry[] = [];
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			!isDigest(entry.currentManifestId) ||
			!isDigest(entry.targetManifestId) ||
			!isDigest(entry.planDigest) ||
			!isDigest(entry.packChecksum) ||
			!Array.isArray(entry.scopePaths) ||
			entry.scopePaths.some((path) => typeof path !== "string")
		) continue;
		entries.push({
			currentManifestId: entry.currentManifestId as ManifestId,
			targetManifestId: entry.targetManifestId as ManifestId,
			scopePaths: entry.scopePaths.filter((path): path is string => typeof path === "string"),
			planDigest: entry.planDigest,
			packChecksum: entry.packChecksum,
		});
	}
	return { schemaVersion: 1, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
