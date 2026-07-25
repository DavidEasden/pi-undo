import { randomUUID } from "node:crypto";

import { canonicalJson, checksum } from "./encoding.ts";
import type {
	CheckpointRecord,
	CursorState,
	ManifestId,
	OperationDescriptor,
	ResultCode,
	SessionFileIdentity,
	SnapshotManifest,
} from "./model.ts";
import type { RestorePlan, RestoreResult } from "./restore-engine.ts";

/** 控制器所需的最小运行时适配层；Pi 绑定在 extension 中完成。 */
export interface ControllerDependencies {
	readonly workspaceIdentity: string;
	readonly sessionIdentity: SessionFileIdentity;
	readonly isAgentIdle: () => boolean;
	readonly abortAgent: () => Promise<void>;
	readonly waitForIdle: (deadlineMs: number) => Promise<boolean>;
	readonly getLogicalLeafId: () => string | null;
	readonly acquireWorkspaceLock: () => Promise<{ release(): Promise<void> }>;
	readonly findUserEntryAfter: (startEntryId: string) => string | null;
	readonly resolveSessionTarget: (action: "undo" | "redo", checkpoint: CheckpointRecord) => string | null;
	readonly navigateSession: (action: "undo" | "redo", checkpoint: CheckpointRecord) => Promise<{
		readonly cancelled: boolean;
		readonly logicalLeafId: string | null;
	}>;
	readonly restoreSessionLeaf: (logicalLeafId: string | null) => Promise<boolean>;
	readonly resolveTreeTarget: (targetEntryId: string | null) => Promise<{
		readonly logicalLeafId: string | null;
		readonly targetManifestId: ManifestId;
		readonly undoStack: readonly CheckpointRecord[];
	}>;
	readonly appendControl: (customType: string, data?: unknown) => Promise<string | null>;
	readonly appendCursor: (cursor: CursorState) => Promise<CursorAppendResult>;
	readonly capture: () => Promise<SnapshotManifest>;
	readonly changedPaths: (before: SnapshotManifest, after: SnapshotManifest) => Promise<readonly string[]>;
	readonly loadManifest: (id: ManifestId) => Promise<SnapshotManifest>;
	readonly planRestore: (
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths?: readonly string[],
	) => Promise<RestorePlan>;
	readonly applyRestore: (plan: RestorePlan, target: SnapshotManifest) => Promise<RestoreResult>;
	readonly recoverPending: () => Promise<{
		readonly kind: "clean" | "recovered" | "locked";
		readonly operations: number;
		readonly reason?: string;
	}>;
	readonly journal: JournalPort;
	readonly clock: () => number;
}

export interface JournalPort {
	prepare(descriptor: OperationDescriptor, plan: unknown): Promise<void>;
	setPhase(
		opId: string,
		phase: "SESSION_MOVED" | "APPLYING" | "FILES_VERIFIED" | "CURSOR_COMMITTED" | "ABORTING" | "ABORTED" | "RECOVERY_REQUIRED",
		options?: { readonly observedLogicalLeaf?: string | null },
	): Promise<void>;
	markCommitted(opId: string): Promise<void>;
	loadPending(): Promise<readonly unknown[]>;
}

export type CursorAppendResult =
	| { readonly kind: "durable"; readonly logicalLeafId: string | null }
	| { readonly kind: "volatile"; readonly reason: string }
	| { readonly kind: "recovery_required"; readonly reason: string };

export interface OperationResult {
	readonly code: ResultCode;
	readonly changedFiles: number;
	readonly message?: string;
	readonly refillPrompt?: string;
}

export interface InputEventResult {
	readonly action: "continue" | "handled";
}

export interface InputContext {
	readonly streaming: boolean;
}

export interface SessionBeforeTreeEvent {
	readonly targetLeafId: string | null;
}

export interface SessionBeforeTreeResult {
	readonly cancel: true;
}

export interface SessionTreeEvent {
	readonly newLeafId: string | null;
	readonly navigationTargetLeafId?: string | null;
}

export interface HistoryState {
	readonly undoCount: number;
	readonly redoCount: number;
	readonly locked: boolean;
}

export interface UndoController {
	prepareInput(text: string, context: InputContext): Promise<InputEventResult>;
	beforeAgentStart(): Promise<void>;
	agentSettled(): Promise<void>;
	undo(): Promise<OperationResult>;
	redo(): Promise<OperationResult>;
	beforeTree(event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined>;
	afterTree(event: SessionTreeEvent): Promise<void>;
	cancelTree?(): Promise<void>;
	recover(): Promise<void>;
	history(): HistoryState;
}

interface StagedRun {
	readonly rawPrompt: string;
	readonly before: SnapshotManifest;
	readonly sourceLogicalLeaf: string | null;
	startEntryId?: string | null;
}

export interface ControllerRedoEntry {
	readonly checkpoint: CheckpointRecord;
	readonly targetManifestId: ManifestId;
}

export interface ControllerInitialState {
	readonly undoStack?: readonly CheckpointRecord[];
	readonly redoStack?: readonly ControllerRedoEntry[];
	readonly historyPaused?: boolean;
	readonly locked?: boolean;
}

interface PendingTree {
	readonly descriptor: OperationDescriptor;
	readonly rollback: SnapshotManifest;
	readonly target: SnapshotManifest;
	readonly plan: RestorePlan;
	readonly undoStack: readonly CheckpointRecord[];
	readonly lease: { release(): Promise<void> };
}

/**
 * 将 Pi 生命周期事件转换为可恢复的文件系统事务。
 * 此类不直接调用 Pi API，便于单测和避免 session runtime 替换后的陈旧引用。
 */
export class UndoControllerImpl implements UndoController {
	private readonly dependencies: ControllerDependencies;
	private readonly undoStack: CheckpointRecord[] = [];
	private readonly redoStack: ControllerRedoEntry[] = [];
	private staged: StagedRun | undefined;
	private pendingTree: PendingTree | undefined;
	private locked = false;
	private historyPaused = false;
	private operationInFlight = false;
	private lastSafetyManifestId: ManifestId | null = null;

	constructor(dependencies: ControllerDependencies, initialState: ControllerInitialState = {}) {
		this.dependencies = dependencies;
		this.undoStack.push(...(initialState.undoStack ?? []));
		this.redoStack.push(...(initialState.redoStack ?? []));
		this.historyPaused = initialState.historyPaused ?? false;
		this.locked = initialState.locked ?? false;
	}

	history(): HistoryState {
		return { undoCount: this.undoStack.length, redoCount: this.redoStack.length, locked: this.locked };
	}

	async prepareInput(text: string, context: InputContext): Promise<InputEventResult> {
		if (this.locked || this.operationInFlight) return { action: "handled" };
		if (context.streaming || text.length === 0) return { action: "continue" };
		try {
			const before = await this.captureWithWorkspaceLock();
			this.historyPaused = false;
			this.staged = { rawPrompt: text, before, sourceLogicalLeaf: this.dependencies.getLogicalLeafId() };
			return { action: "continue" };
		} catch {
			// 无法证明输入前状态时保留编辑器输入；本轮尚未开始，可由用户直接重试。
			return { action: "handled" };
		}
	}

	async beforeAgentStart(): Promise<void> {
		if (this.locked || this.staged === undefined) return;
		try {
			this.staged.startEntryId = await this.dependencies.appendControl("pi-undo:start", {
				schemaVersion: 1,
				beforeManifestId: this.staged.before.manifestId,
				sourceLogicalLeaf: this.staged.sourceLogicalLeaf,
			});
			if (this.staged.startEntryId === null) {
				this.locked = true;
				this.staged = undefined;
				await this.dependencies.appendControl("pi-undo:barrier", { reason: "start_entry_missing" }).catch(() => {});
				return;
			}
		} catch {
			this.locked = true;
			this.staged = undefined;
			return;
		}
		// 只有实际开始一个新 run 才会令 redo 分支失效；未启动的输入不会改变历史。
		this.redoStack.length = 0;
	}

	async agentSettled(): Promise<void> {
		const staged = this.staged;
		this.staged = undefined;
		if (this.locked || staged === undefined) return;
		if (staged.startEntryId === undefined || staged.startEntryId === null) {
			// Pi 没有提供已落盘的 start entry ID，不能把后续 assistant 输出归属到该 checkpoint。
			this.locked = true;
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "start_entry_missing" }).catch(() => {});
			return;
		}
		const userEntryId = this.dependencies.findUserEntryAfter(staged.startEntryId);
		if (userEntryId === null) {
			this.locked = true;
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "user_entry_missing" }).catch(() => {});
			return;
		}
		try {
			const after = await this.captureWithWorkspaceLock();
			const changedPaths = await this.dependencies.changedPaths(staged.before, after);
			const endLeafId = this.dependencies.getLogicalLeafId() ?? staged.startEntryId;
			const checkpoint = this.createCheckpoint(staged, after, changedPaths, userEntryId, endLeafId);
			const checkpointEntryId = await this.dependencies.appendControl("pi-undo:checkpoint", checkpoint);
			if (checkpointEntryId === null) {
				this.locked = true;
				await this.dependencies.appendControl("pi-undo:barrier", { reason: "checkpoint_entry_missing" }).catch(() => {});
				return;
			}
			this.undoStack.push(checkpoint);
		} catch {
			this.historyPaused = true;
			this.undoStack.length = 0;
			this.redoStack.length = 0;
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "settled_capture_failed" }).catch(() => {});
		}
	}

	async undo(): Promise<OperationResult> {
		if (this.historyPaused) return { code: "history_paused", changedFiles: 0 };
		const checkpoint = this.undoStack.at(-1);
		if (checkpoint === undefined) return noop();
		const result = await this.runOperation("undo", checkpoint);
		if (result.code === "ok" && this.lastSafetyManifestId !== null) {
			this.undoStack.pop();
			this.redoStack.push({ checkpoint, targetManifestId: this.lastSafetyManifestId });
			return { ...result, refillPrompt: checkpoint.rawPrompt };
		}
		return result;
	}

	async redo(): Promise<OperationResult> {
		if (this.historyPaused) return { code: "history_paused", changedFiles: 0 };
		const redo = this.redoStack.at(-1);
		if (redo === undefined) return noop();
		const result = await this.runOperation("redo", redo.checkpoint, redo.targetManifestId);
		if (result.code === "ok") {
			this.redoStack.pop();
			this.undoStack.push(redo.checkpoint);
		}
		return result;
	}

	async beforeTree(event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined> {
		if (!this.dependencies.isAgentIdle()) {
			await this.dependencies.abortAgent();
			return { cancel: true };
		}
		if (this.locked || this.historyPaused || this.operationInFlight) return { cancel: true };
		this.operationInFlight = true;
		let lease: { release(): Promise<void> } | undefined;
		try {
			lease = await this.dependencies.acquireWorkspaceLock();
			const rollback = await this.dependencies.capture();
			const targetState = await this.dependencies.resolveTreeTarget(event.targetLeafId);
			const target = await this.dependencies.loadManifest(targetState.targetManifestId);
			const plan = await this.dependencies.planRestore(rollback, target);
			const descriptor = this.createDescriptor("tree", rollback, target, plan, targetState.logicalLeafId);
			await this.dependencies.journal.prepare(descriptor, plan);
			this.pendingTree = { descriptor, rollback, target, plan, undoStack: targetState.undoStack, lease };
			return undefined;
		} catch {
			if (lease !== undefined) {
				await lease.release().catch(() => { this.locked = true; });
			}
			this.operationInFlight = false;
			return { cancel: true };
		}
	}

	async afterTree(event: SessionTreeEvent): Promise<void> {
		const pending = this.pendingTree;
		if (pending === undefined) return;
		this.pendingTree = undefined;
		try {
			if ((event.navigationTargetLeafId ?? event.newLeafId) !== pending.descriptor.toLogicalLeaf) {
				this.locked = true;
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "SESSION_MOVED", {
				observedLogicalLeaf: event.newLeafId,
			});
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "APPLYING");
			const applied = await this.dependencies.applyRestore(pending.plan, pending.target);
			if (applied.code !== "ok") {
				this.locked = true;
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "FILES_VERIFIED");
			const cursorResult = await this.dependencies.appendCursor(
				this.createTreeCursor(pending.descriptor, event.newLeafId, pending.undoStack),
			);
			if (cursorResult.kind !== "durable") {
				this.locked = true;
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "CURSOR_COMMITTED");
			await this.dependencies.journal.markCommitted(pending.descriptor.opId);
			this.undoStack.splice(0, this.undoStack.length, ...pending.undoStack);
			this.redoStack.length = 0;
		} catch {
			this.locked = true;
		} finally {
			await pending.lease.release().catch(() => { this.locked = true; });
			this.operationInFlight = false;
		}
	}

	async cancelTree(): Promise<void> {
		const pending = this.pendingTree;
		if (pending === undefined) return;
		this.pendingTree = undefined;
		try {
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "ABORTING");
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "ABORTED");
		} catch {
			this.locked = true;
		} finally {
			await pending.lease.release().catch(() => { this.locked = true; });
			this.operationInFlight = false;
		}
	}

	async recover(): Promise<void> {
		try {
			const result = await this.dependencies.recoverPending();
			if (result.kind === "locked") this.locked = true;
		} catch {
			this.locked = true;
		}
	}

	private async runOperation(
		action: "undo" | "redo",
		checkpoint: CheckpointRecord,
		targetManifestId?: ManifestId,
	): Promise<OperationResult> {
		if (this.locked || this.operationInFlight) return { code: "busy", changedFiles: 0 };
		this.operationInFlight = true;
		this.lastSafetyManifestId = null;
		let lease: { release(): Promise<void> } | undefined;
		try {
			if (!await this.ensureIdle()) return { code: "idle_timeout", changedFiles: 0 };
			try {
				lease = await this.dependencies.acquireWorkspaceLock();
			} catch {
				return { code: "busy", changedFiles: 0 };
			}
			let rollback: SnapshotManifest;
			try {
				rollback = await this.dependencies.capture();
			} catch {
				return { code: "capture_failed", changedFiles: 0 };
			}
			let target: SnapshotManifest;
			let plan: RestorePlan;
			let targetLogicalLeaf: string | null;
			try {
				target = await this.dependencies.loadManifest(
					targetManifestId ?? (action === "undo" ? checkpoint.beforeManifestId : checkpoint.afterManifestId),
				);
				plan = await this.dependencies.planRestore(rollback, target, checkpoint.changedPaths);
				targetLogicalLeaf = this.dependencies.resolveSessionTarget(action, checkpoint);
			} catch {
				return { code: "restore_failed_safe", changedFiles: 0 };
			}
			const descriptor = this.createDescriptor(action, rollback, target, plan, targetLogicalLeaf);
			await this.dependencies.journal.prepare(descriptor, plan);
			const navigation = await this.dependencies.navigateSession(action, checkpoint);
			if (navigation.cancelled) {
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTING");
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
				return { code: "restore_failed_safe", changedFiles: 0 };
			}
			if (navigation.logicalLeafId !== descriptor.toLogicalLeaf) {
				this.locked = true;
				await this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED");
				return { code: "recovery_required", changedFiles: 0 };
			}
			await this.dependencies.journal.setPhase(descriptor.opId, "SESSION_MOVED", {
				observedLogicalLeaf: navigation.logicalLeafId,
			});
			await this.dependencies.journal.setPhase(descriptor.opId, "APPLYING");
			const applied = await this.dependencies.applyRestore(plan, target);
			if (applied.code !== "ok") return this.compensate(descriptor, rollback, target, applied);
			await this.dependencies.journal.setPhase(descriptor.opId, "FILES_VERIFIED");
			const cursor = this.createCursor(descriptor, action, checkpoint);
			const cursorResult = await this.dependencies.appendCursor(cursor);
			if (cursorResult.kind === "recovery_required") {
				this.locked = true;
				await this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {});
				return { code: "recovery_required", changedFiles: applied.verifiedPaths };
			}
			if (cursorResult.kind === "volatile") {
				return this.compensate(descriptor, rollback, target, {
					code: "recovery_required",
					verifiedPaths: applied.verifiedPaths,
					totalPaths: applied.totalPaths,
				});
			}
			await this.dependencies.journal.setPhase(descriptor.opId, "CURSOR_COMMITTED");
			await this.dependencies.journal.markCommitted(descriptor.opId);
			this.lastSafetyManifestId = rollback.manifestId;
			return { code: "ok", changedFiles: applied.verifiedPaths };
		} catch {
			this.locked = true;
			return { code: "recovery_required", changedFiles: 0 };
		} finally {
			if (lease !== undefined) {
				await lease.release().catch(() => { this.locked = true; });
			}
			this.operationInFlight = false;
		}
	}

	private async ensureIdle(): Promise<boolean> {
		if (this.dependencies.isAgentIdle()) return true;
		try {
			await this.dependencies.abortAgent();
			return await this.dependencies.waitForIdle(this.dependencies.clock() + 30_000);
		} catch {
			return false;
		}
	}

	private async captureWithWorkspaceLock(): Promise<SnapshotManifest> {
		const lease = await this.dependencies.acquireWorkspaceLock();
		try {
			return await this.dependencies.capture();
		} finally {
			await lease.release();
		}
	}

	private async compensate(
		descriptor: OperationDescriptor,
		rollback: SnapshotManifest,
		target: SnapshotManifest,
		failure: RestoreResult,
	): Promise<OperationResult> {
		try {
			await this.dependencies.journal.setPhase(descriptor.opId, "ABORTING");
			if (!await this.dependencies.restoreSessionLeaf(descriptor.fromLogicalLeaf)) {
				throw new Error("session rollback failed");
			}
			const rollbackPlan = await this.dependencies.planRestore(target, rollback, descriptor.scopePaths);
			const reverted = await this.dependencies.applyRestore(rollbackPlan, rollback);
			if (reverted.code === "ok") {
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
				return { code: "restore_failed_safe", changedFiles: failure.verifiedPaths };
			}
		} catch {
			// 下面统一进入 recovery lock。
		}
		this.locked = true;
		await this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {});
		return { code: "recovery_required", changedFiles: failure.verifiedPaths };
	}

	private createCheckpoint(
		staged: StagedRun,
		after: SnapshotManifest,
		changedPaths: readonly string[],
		userEntryId: string,
		endLeafId: string,
	): CheckpointRecord {
		const payload = {
			schemaVersion: 1 as const,
			checkpointId: randomUUID(),
			runId: randomUUID(),
			sessionIdentity: this.dependencies.sessionIdentity,
			startEntryId: staged.startEntryId ?? endLeafId,
			userEntryId,
			endLeafId,
			rawPrompt: staged.rawPrompt,
			beforeManifestId: staged.before.manifestId,
			afterManifestId: after.manifestId,
			changedPaths: [...changedPaths].sort(),
		};
		return { ...payload, checksum: checksum(canonicalJson(payload)) };
	}

	private createDescriptor(
		action: "undo" | "redo" | "tree",
		rollback: SnapshotManifest,
		target: SnapshotManifest,
		plan: RestorePlan,
		targetLogicalLeaf: string | null,
	): OperationDescriptor {
		const scopePaths = [...plan.deletePaths, ...plan.writePaths].sort();
		const payload = {
			schemaVersion: 1 as const,
			opId: `op-${randomUUID()}`,
			sessionIdentity: this.dependencies.sessionIdentity,
			workspaceIdentity: this.dependencies.workspaceIdentity,
			action,
			fromLogicalLeaf: this.dependencies.getLogicalLeafId(),
			toLogicalLeaf: targetLogicalLeaf,
			targetManifestId: target.manifestId,
			rollbackManifestId: rollback.manifestId,
			coverage: `paths:${checksum(canonicalJson(scopePaths))}`,
			scopePaths,
			planDigest: plan.planDigest,
		};
		return { ...payload, checksum: checksum(canonicalJson(payload)) };
	}

	private createCursor(descriptor: OperationDescriptor, action: "undo" | "redo", checkpoint: CheckpointRecord): CursorState {
		const redoStack = action === "undo"
			? [...this.redoStack.map((entry) => entry.checkpoint.checkpointId), checkpoint.checkpointId]
			: this.redoStack.slice(0, -1).map((entry) => entry.checkpoint.checkpointId);
		const undoHead = action === "undo"
			? this.undoStack.at(-2)?.checkpointId ?? null
			: checkpoint.checkpointId;
		const payload = {
			schemaVersion: 1 as const,
			opId: descriptor.opId,
			action,
			sessionIdentity: descriptor.sessionIdentity,
			fromLogicalLeaf: descriptor.fromLogicalLeaf,
			toLogicalLeaf: descriptor.toLogicalLeaf,
			targetManifestId: descriptor.targetManifestId,
			rollbackManifestId: descriptor.rollbackManifestId,
			undoHead,
			redoStack,
			descriptorChecksum: descriptor.checksum,
		};
		return { ...payload, checksum: checksum(canonicalJson(payload)) };
	}

	private createTreeCursor(
		descriptor: OperationDescriptor,
		observedLogicalLeaf: string | null,
		undoStack: readonly CheckpointRecord[],
	): CursorState {
		const payload = {
			schemaVersion: 1 as const,
			opId: descriptor.opId,
			action: "tree" as const,
			sessionIdentity: descriptor.sessionIdentity,
			fromLogicalLeaf: descriptor.fromLogicalLeaf,
			toLogicalLeaf: observedLogicalLeaf,
			targetManifestId: descriptor.targetManifestId,
			rollbackManifestId: descriptor.rollbackManifestId,
			undoHead: undoStack.at(-1)?.checkpointId ?? null,
			redoStack: [],
			descriptorChecksum: descriptor.checksum,
		};
		return { ...payload, checksum: checksum(canonicalJson(payload)) };
	}
}

function noop(): OperationResult {
	return { code: "noop", changedFiles: 0 };
}
