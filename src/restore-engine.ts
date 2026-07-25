import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeBytesAtomic } from "./atomic-fs.ts";
import { assertManifest, canonicalJson, checksum } from "./encoding.ts";
import type { ManifestId, RestorePath, SnapshotManifest, SnapshotRoot } from "./model.ts";
import {
	assertNoSymlinkEscape,
	relativeSafePath,
	sortDeletePaths,
	sortWritePaths,
} from "./path-safety.ts";
import { RootDiscovery, type RootTopology } from "./root-discovery.ts";
import { SnapshotStoreError, type SnapshotStore } from "./snapshot-store.ts";

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
}

export interface RestoreEngine {
	plan(current: SnapshotManifest, target: SnapshotManifest, scopePaths?: readonly string[]): Promise<RestorePlan>;
	apply(plan: RestorePlan, target: SnapshotManifest): Promise<RestoreResult>;
}

export interface RestoreEngineOptions {
	readonly workspaceRoot: string;
	readonly store: SnapshotStore;
	readonly discovery?: RootDiscovery;
	readonly beforeMutation?: (mutation: RestoreMutation) => void | Promise<void>;
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

interface MutationContext {
	readonly phase: RestoreMutation["phase"];
	readonly sourceManifestId: ManifestId;
	readonly targetManifestId: ManifestId;
	readonly sourcePaths: ReadonlyMap<string, OwnedPath>;
	readonly targetPaths: ReadonlyMap<string, OwnedPath>;
	readonly plannedDeletePaths: ReadonlySet<string>;
	readonly sourceIgnoredPaths: ReadonlySet<string>;
	ordinal: number;
}

export class RestoreEngine {
	private readonly requestedWorkspaceRoot: string;
	private readonly workspaceRoot: string;
	private readonly store: SnapshotStore;
	private readonly discovery: RootDiscovery;
	private readonly beforeMutation: RestoreEngineOptions["beforeMutation"];

	constructor(options: RestoreEngineOptions) {
		this.requestedWorkspaceRoot = resolve(options.workspaceRoot);
		this.workspaceRoot = realpathSync(this.requestedWorkspaceRoot);
		this.store = options.store;
		this.discovery = options.discovery ?? new RootDiscovery();
		this.beforeMutation = options.beforeMutation;
	}

	async plan(
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths?: readonly string[],
	): Promise<RestorePlan> {
		assertManifest(current);
		assertManifest(target);
		assertCompatibleManifests(current, target);
		const scope = scopePaths === undefined ? undefined : this.canonicalScope(scopePaths);
		const isScopedPath = (path: string): boolean => scope === undefined || scope.has(path);
		await Promise.all([
			this.store.assertComplete(current.manifestId),
			this.store.assertComplete(target.manifestId),
		]);

		const [currentPaths, targetPaths] = await Promise.all([
			this.readOwnedPaths(current),
			this.readOwnedPaths(target),
		]);
		const targetIgnoredPaths = ignoredWorkspacePaths(target);
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
				if (isProtectedByIgnoredProof(path, owned.entry.kind, targetIgnoredPaths)) {
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
		return {
			...semanticPlan,
			planDigest: checksum(canonicalJson(semanticPlan)),
		};
	}

	async apply(plan: RestorePlan, target: SnapshotManifest): Promise<RestoreResult> {
		assertManifest(target);
		if (plan.targetManifestId !== target.manifestId) {
			throw new Error("restore plan target manifest ID 不匹配");
		}
		if (!/^[0-9a-f]{64}$/.test(plan.planDigest)) {
			throw new Error("restore plan digest 无效");
		}
		if (!hasValidPlanDigest(plan)) {
			throw new Error("restore plan digest 与语义字段不匹配");
		}
		const recoveryReason = `restore:${plan.planDigest}`;
		const attemptReason = `${recoveryReason}:attempt:${randomUUID()}`;
		const pinned = [...new Set([plan.currentManifestId, target.manifestId])];
		const acquired: ManifestId[] = [];
		try {
			for (const manifestId of pinned) {
				await this.store.pin(manifestId, attemptReason);
				acquired.push(manifestId);
			}
		} catch (error) {
			await Promise.all(acquired.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			throw error;
		}

		try {
			const result = await this.applyPinned(plan, target);
			if (result.code === "partial_restore" || result.code === "recovery_required") {
				let recoveryPinned = true;
				for (const manifestId of pinned) {
					try {
						await this.store.pin(manifestId, recoveryReason);
					} catch {
						recoveryPinned = false;
						break;
					}
				}
				if (recoveryPinned) {
					await Promise.all(pinned.map(
						(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
					));
				}
				return result;
			}

			await Promise.all(pinned.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			if (result.code === "ok" || result.postFingerprint !== undefined) {
				await Promise.all(pinned.map(
					(manifestId) => this.store.unpin(manifestId, recoveryReason).catch(() => {}),
				));
			}
			return result;
		} catch (error) {
			await Promise.all(pinned.map(
				(manifestId) => this.store.unpin(manifestId, attemptReason).catch(() => {}),
			));
			throw error;
		}
	}

	private async applyPinned(plan: RestorePlan, target: SnapshotManifest): Promise<RestoreResult> {
		const [current, storedTarget] = await Promise.all([
			this.store.loadManifest(plan.currentManifestId),
			this.store.loadManifest(target.manifestId),
		]);
		if (canonicalJson(storedTarget) !== canonicalJson(target)) {
			throw new Error("target manifest 与 store 内容不一致");
		}
		assertCompatibleManifests(current, target);
		let expectedPlan: RestorePlan;
		try {
			expectedPlan = await this.plan(current, target, plan.scopePaths);
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
			topologyBefore = await this.discovery.discover(this.workspaceRoot);
			this.assertCurrentTopology(current, target, topologyBefore);
		} catch {
			return { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 };
		}
		const [currentPaths, targetPaths] = await Promise.all([
			this.readOwnedPaths(current),
			this.readOwnedPaths(target),
		]);
		try {
			await this.assertCompleteVisibleSubset(topologyBefore, [current, target]);
		} catch {
			return { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 };
		}
		const preflight = await this.verifyKnownState(current, target, currentPaths, targetPaths, plan.scopePaths);
		if (!preflight.ok) {
			return {
				code: "restore_failed_safe",
				verifiedPaths: preflight.verifiedPaths,
				totalPaths: preflight.totalPaths,
			};
		}

		const mutationContext: MutationContext = {
			phase: "apply",
			ordinal: 0,
			sourceManifestId: current.manifestId,
			targetManifestId: target.manifestId,
			sourcePaths: currentPaths,
			targetPaths,
			plannedDeletePaths: new Set(plan.deletePaths),
			sourceIgnoredPaths: ignoredWorkspacePaths(current),
		};
		try {
			for (const path of plan.deletePaths) {
				if (await this.pathIsShadowedByTarget(target.manifestId, path, targetPaths)) {
					continue;
				}
				await this.deletePath(path, mutationContext);
			}
			await this.writePlannedPaths(target.manifestId, targetPaths, plan.writePaths, mutationContext);

			const topologyAfter = await this.discovery.discover(this.workspaceRoot);
			assertUnchangedTopology(topologyBefore, topologyAfter);
			await this.assertCompleteVisibleSubset(topologyAfter, [target]);
			const verification = await this.verifyTarget(
				target,
				currentPaths,
				targetPaths,
				plan.deletePaths,
				plan.scopePaths,
			);
			return {
				code: "ok",
				verifiedPaths: verification.verifiedPaths,
				totalPaths: verification.totalPaths,
				postFingerprint: postFingerprint(target.manifestId, topologyAfter, verification.pathFingerprints),
			};
		} catch {
			return this.rollback(current, target, topologyBefore, currentPaths, targetPaths, plan.scopePaths);
		}
	}

	private async readOwnedPaths(manifest: SnapshotManifest): Promise<Map<string, OwnedPath>> {
		const result = new Map<string, OwnedPath>();
		for (const root of manifest.roots) {
			assertNotGitMetadata(root.relativeRoot);
			const entries = await this.store.listTree(manifest.manifestId, root.relativeRoot);
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

	private assertCurrentTopology(
		current: SnapshotManifest,
		target: SnapshotManifest,
		actual: RootTopology,
	): void {
		if (
			actual.workspaceIdentity !== current.workspaceIdentity ||
			actual.fingerprint !== current.topologyFingerprint
		) {
			throw new Error("apply 前 workspace topology 与 current manifest 不一致");
		}
		const currentRoots = new Map(current.roots.map((root) => [root.relativeRoot, root]));
		for (const targetRoot of target.roots) {
			const currentRoot = currentRoots.get(targetRoot.relativeRoot);
			if (currentRoot !== undefined && targetRoot.state === "active" && currentRoot.state !== "active") {
				throw new Error(`restore 不能把 inactive root 物化为 active：${targetRoot.relativeRoot}`);
			}
			if (
				currentRoot !== undefined &&
				targetRoot.state === "active" &&
				(currentRoot.sourceIdentity !== targetRoot.sourceIdentity ||
					currentRoot.privateRepositoryId !== targetRoot.privateRepositoryId)
			) {
				throw new Error(`restore boundary root identity 冲突：${targetRoot.relativeRoot}`);
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
		let verifiedPaths = 0;
		for (const path of paths) {
			if (await this.pathIsShadowedByTarget(target.manifestId, path, targetPaths)) {
				verifiedPaths += 1;
				continue;
			}
			const currentPath = currentPaths.get(path);
			const targetPath = targetPaths.get(path);
			const matchesCurrent = currentPath !== undefined &&
				await this.entryMatches(current.manifestId, currentPath);
			const matchesTarget = !matchesCurrent && targetPath !== undefined &&
				await this.entryMatches(target.manifestId, targetPath);
			const matchesAbsentSide = !matchesCurrent && !matchesTarget &&
				(currentPath === undefined || targetPath === undefined) &&
				await this.pathIsAbsent(path);
			if (!matchesCurrent && !matchesTarget && !matchesAbsentSide) {
				return { ok: false, verifiedPaths, totalPaths: paths.length };
			}
			verifiedPaths += 1;
		}
		return { ok: true, verifiedPaths, totalPaths: paths.length };
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
		await this.mutate(context, "delete", path, () => unlink(absolutePath));
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
			await this.mutate(context, "symlink", path, () => symlink(linkText, absolutePath));
			return;
		}

		if (target.entry.blobId === null) {
			throw new Error(`普通文件缺少 blob：${path}`);
		}
		const bytes = await this.store.readBlob(manifestId, target.root.relativeRoot, target.entry.blobId);
		if (bytes.byteLength !== target.entry.size) {
			throw new Error(`普通文件 blob 大小不匹配：${path}`);
		}
		await this.mutate(
			context,
			"write",
			path,
			() => writeBytesAtomic(this.absolutePath(path), bytes, target.entry.mode & 0o777),
		);
	}

	private async rollback(
		current: SnapshotManifest,
		target: SnapshotManifest,
		topologyBefore: RootTopology,
		currentPaths: ReadonlyMap<string, OwnedPath>,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		scopePaths?: readonly string[],
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
			};
			for (const path of rollbackPlan.deletePaths) {
				if (await this.pathIsShadowedByTarget(current.manifestId, path, currentPaths)) {
					continue;
				}
				await this.deletePath(path, context);
			}
			await this.writePlannedPaths(current.manifestId, currentPaths, rollbackPlan.writePaths, context);
			const topologyAfter = await this.discovery.discover(this.workspaceRoot);
			assertUnchangedTopology(topologyBefore, topologyAfter);
			await this.assertCompleteVisibleSubset(topologyAfter, [current]);
			const verification = await this.verifyTarget(
				current,
				targetPaths,
				currentPaths,
				rollbackPlan.deletePaths,
				rollbackPlan.scopePaths,
			);
			return {
				code: "restore_failed_safe",
				verifiedPaths: verification.verifiedPaths,
				totalPaths: verification.totalPaths,
				postFingerprint: postFingerprint(
					current.manifestId,
					topologyAfter,
					verification.pathFingerprints,
				),
			};
		} catch {
			if (rollbackPlan !== undefined) {
				try {
					const topologyAfter = await this.discovery.discover(this.workspaceRoot);
					assertUnchangedTopology(topologyBefore, topologyAfter);
					await this.assertCompleteVisibleSubset(topologyAfter, [current]);
					const verification = await this.verifyTarget(
						current,
						targetPaths,
						currentPaths,
						rollbackPlan.deletePaths,
						rollbackPlan.scopePaths,
					);
					return {
						code: "restore_failed_safe",
						verifiedPaths: verification.verifiedPaths,
						totalPaths: verification.totalPaths,
						postFingerprint: postFingerprint(
							current.manifestId,
							topologyAfter,
							verification.pathFingerprints,
						),
					};
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
		mutation: () => Promise<void>,
	): Promise<void> {
		context.ordinal += 1;
		await this.beforeMutation?.({ phase: context.phase, ordinal: context.ordinal, kind, path });
		await this.assertMutationPath(path);
		await this.assertMutationState(context, kind, path);
		await mutation();
	}

	private async writePlannedPaths(
		manifestId: ManifestId,
		targetPaths: ReadonlyMap<string, OwnedPath>,
		writePaths: readonly string[],
		context: MutationContext,
	): Promise<void> {
		for (const kind of ["directory", "leaf"] as const) {
			for (const path of writePaths) {
				const target = targetPaths.get(path);
				if (target === undefined) {
					throw new Error(`${context.phase} plan 引用了 manifest 外路径：${path}`);
				}
				if ((target.entry.kind === "directory") !== (kind === "directory")) {
					continue;
				}
				if (context.sourceIgnoredPaths.has(path)) {
					if (await this.entryMatches(manifestId, target)) {
						continue;
					}
					throw new Error(`${context.phase} 的 ignored-present 路径与目标内容冲突：${path}`);
				}
				await this.writePath(manifestId, target, context);
			}
		}
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
	): Promise<void> {
		if (allowedManifests.some((manifest) => manifest.coverage !== "complete")) {
			return;
		}
		const allowedPaths = new Set<string>();
		for (const manifest of allowedManifests) {
			for (const path of ignoredWorkspacePaths(manifest)) {
				allowedPaths.add(path);
			}
			const paths = await this.readOwnedPaths(manifest);
			for (const [path, owned] of paths) {
				if (owned.entry.kind !== "directory") {
					allowedPaths.add(path);
				}
			}
		}

		const live = await this.store.capture(topology);
		await this.store.assertComplete(live.manifestId);
		for (const [path, owned] of await this.readOwnedPaths(live)) {
			if (owned.entry.kind !== "directory" && !allowedPaths.has(path)) {
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
		const pathFingerprints: string[] = [];
		const scope = scopePaths === undefined ? undefined : new Set(scopePaths);
		for (const [path, owned] of targetPaths) {
			if (scope !== undefined && !scope.has(path)) continue;
			pathFingerprints.push(await this.verifyEntry(target.manifestId, owned));
		}
		let verifiedPaths = pathFingerprints.length;
		let totalPaths = pathFingerprints.length;
		for (const path of deletePaths) {
			if (
				targetPaths.has(path) ||
				currentPaths.get(path)?.entry.kind === "directory" ||
				hasNonDirectoryAncestor(path, targetPaths)
			) {
				continue;
			}
			totalPaths += 1;
			try {
				await lstat(this.absolutePath(path));
				throw new Error(`目标应删除的路径仍然存在：${path}`);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					throw error;
				}
			}
			verifiedPaths += 1;
		}
		return {
			verifiedPaths,
			totalPaths,
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
		const [actual, expected] = await Promise.all([
			readFile(this.absolutePath(path)),
			this.store.readBlob(manifestId, owned.root.relativeRoot, owned.entry.blobId),
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

function sameEntry(left: RestorePath, right: RestorePath): boolean {
	return left.kind === right.kind &&
		left.mode === right.mode &&
		left.blobId === right.blobId &&
		left.size === right.size &&
		left.linkText === right.linkText;
}

function assertCompatibleManifests(current: SnapshotManifest, target: SnapshotManifest): void {
	if (current.workspaceIdentity !== target.workspaceIdentity) {
		throw new Error("restore manifest 不属于同一 workspace");
	}
	if (current.coverage !== target.coverage) {
		throw new Error("restore manifest coverage 不一致，不能推断缺失路径");
	}
	if (current.roots.some((root) => root.state === "broken") || target.roots.some((root) => root.state === "broken")) {
		throw new Error("broken root 不能用于 restore");
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

function workspacePath(root: string, path: string): string {
	return root === "." ? path : path === "." ? root : `${root}/${path}`;
}

function ignoredWorkspacePaths(manifest: SnapshotManifest): Set<string> {
	return new Set(manifest.roots.flatMap((root) =>
		root.ignoredPresentPaths.map((path) => workspacePath(root.relativeRoot, path))
	));
}

function isProtectedByIgnoredProof(
	path: string,
	kind: RestorePath["kind"],
	ignoredPaths: ReadonlySet<string>,
): boolean {
	if (kind !== "directory") {
		return ignoredPaths.has(path);
	}
	return [...ignoredPaths].some((ignoredPath) => ignoredPath.startsWith(`${path}/`));
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

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
