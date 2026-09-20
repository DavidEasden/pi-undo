import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalJson, checksum } from "./encoding.ts";
import {
	checkOperation, createOperationScope, currentOperationContext, runWithOperationContext, operationFailure, isUnconfirmedExit,
	configuredTimeout, operationHasUnconfirmedExit, rethrowOperationFailure, withRecoveryBudget,
	type OperationScope, type ProcessDiagnostic,
} from "./operation-context.ts";
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
	readonly capture: (scopePaths?: readonly string[]) => Promise<SnapshotManifest>;
	readonly captureBaseline?: (baseline: SnapshotManifest) => Promise<SnapshotManifest>;
	readonly captureSafety?: (
		referenceManifestId: ManifestId,
		targetManifestId: ManifestId,
		scopePaths: readonly string[],
	) => Promise<SnapshotManifest>;
	readonly changedPaths: (before: SnapshotManifest, after: SnapshotManifest) => Promise<readonly string[]>;
	readonly loadManifest: (id: ManifestId) => Promise<SnapshotManifest>;
	readonly planRestore: (
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths?: readonly string[],
	) => Promise<RestorePlan>;
	readonly prepareDurableRestore?: (
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths: readonly string[],
	) => Promise<void>;
	readonly applyRestore: (
		plan: RestorePlan,
		target: SnapshotManifest,
		operation: { readonly opId: string },
	) => Promise<RestoreResult>;
	readonly recoverPending: () => Promise<{
		readonly kind: "clean" | "recovered" | "locked";
		readonly operations: number;
		readonly reason?: string;
	}>;
	readonly journal: JournalPort;
	readonly clock: () => number;
	readonly operationTimeoutMs?: number;
	readonly onProgress?: (phase: string) => void;
	readonly onOperationStart?: (opId: string) => void;
	readonly onProcess?: (diagnostic: ProcessDiagnostic) => void;
	readonly onOperationEnd?: (opId: string, result: OperationResult) => Promise<void>;
}

export interface JournalPort {
	prepare(descriptor: OperationDescriptor, plan: unknown): Promise<void>;
	setPhase(
		opId: string,
		phase: "SESSION_MOVED" | "APPLYING" | "FILES_VERIFIED" | "CURSOR_COMMITTED" | "ABORTING" | "ABORTED" | "RECOVERY_REQUIRED",
		options?: { readonly observedLogicalLeaf?: string | null },
	): Promise<void>;
	setPhases?(
		opId: string,
		transitions: ReadonlyArray<{
			readonly phase: Parameters<JournalPort["setPhase"]>[1];
			readonly observedLogicalLeaf?: string | null;
		}>,
	): Promise<void>;
	markCommitted(opId: string): Promise<void>;
	loadPending(): Promise<readonly unknown[]>;
}

export type CursorAppendResult =
	| { readonly kind: "durable"; readonly logicalLeafId: string | null }
	| { readonly kind: "volatile"; readonly reason: string }
	| { readonly kind: "recovery_required"; readonly reason: string };

export interface OperationTiming {
	readonly phase: string;
	readonly durationMs: number;
}

export interface OperationResult {
	readonly code: ResultCode;
	readonly changedFiles: number;
	readonly message?: string;
	readonly refillPrompt?: string;
	readonly timings?: readonly OperationTiming[];
}

export type InputEventResult =
	| { readonly action: "continue" }
	| { readonly action: "handled" }
	| { readonly action: "defer" };

export interface InputContext {
	readonly streaming: boolean;
}

export interface SessionBeforeTreeEvent {
	readonly targetLeafId: string | null;
	readonly signal?: AbortSignal;
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
	/** 只读的 undo 栈视图（栈底在前）；仅供 /diff 等展示使用。 */
	listCheckpoints(): readonly CheckpointRecord[];
	prepareInput(text: string, context: InputContext): Promise<InputEventResult>;
	/** 在 input hook 中启动快照，但不等待，供 message_end 前的快速路径使用。 */
	beginInput?(text: string, context: InputContext): InputEventResult;
	/** 在用户 message_end 后等待快照并写入 start entry。 */
	commitInput?(): Promise<void>;
	beforeAgentStart(): Promise<void>;
	agentSettled(): Promise<void>;
	undo(): Promise<OperationResult>;
	redo(): Promise<OperationResult>;
	beforeTree(event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined>;
	afterTree(event: SessionTreeEvent): Promise<void>;
	cancelTree?(): Promise<void>;
	cancelOperation?(): boolean;
	dispose?(): Promise<void>;
	recover(): Promise<void>;
	history(): HistoryState;
	/** 当前 recovery lock 的原因；未锁定时返回 undefined。 */
	recoveryReason?(): string | undefined;
	/** 后台预热快照缓存：立即返回，失败静默；后续 capture 会先等预热完成。 */
	warmUp(): void;
	/** 最近一次输入前快照是否失败（此时本次 run 不可 undo，但输入不受影响）。 */
	captureFailed(): boolean;
	/** 最近一次输入前快照失败的原因（截断后的错误消息）；成功时为 undefined。 */
	captureFailureReason(): string | undefined;
}

interface RunCompletion {
	started: boolean;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
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
	readonly recoveryReason?: string;
	readonly recoveryCompleted?: boolean;
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
	private lockedReason: string | undefined;
	private historyPaused = false;
	private operationInFlight = false;
	private operationAction: "undo" | "redo" | undefined;
	private operationProfiler: OperationProfiler | undefined;
	private promptDeferralInFlight = false;
	private lastSafetyManifestId: ManifestId | null = null;
	private lastCaptureFailed = false;
	private lastCaptureFailureMessage: string | undefined;
	private warmUpInFlight: Promise<void> | undefined;
	private warmUpManifest: SnapshotManifest | undefined;
	private pendingInputCapture: { readonly token: symbol; readonly promise: Promise<void> } | undefined;
	private deferAgentStartUntilMessageEnd = false;
	private runCompletion: RunCompletion | undefined;
	private settling: Promise<void> | undefined;
	private inputCommit: Promise<void> | undefined;
	private treePreparation: Promise<SessionBeforeTreeResult | undefined> | undefined;
	private treeApplication: Promise<void> | undefined;
	private treeScope: OperationScope | undefined;
	private treeCancellationRequested = false;
	private disposed = false;
	private activeScope: OperationScope | undefined;
	private activeOperation: Promise<OperationResult> | undefined;
	private readonly backgroundTasks = new Set<Promise<unknown>>();
	private readonly backgroundScopes = new Set<OperationScope>();
	private unsafeExit = false;
	private operationId: string | undefined;
	private transaction: {
		descriptor: OperationDescriptor;
		rollback?: SnapshotManifest;
		target?: SnapshotManifest;
		cursorDurable: boolean;
	} | undefined;
	private recoveryInFlight: Promise<void> | undefined;
	private recoveryCompleted = false;

	constructor(dependencies: ControllerDependencies, initialState: ControllerInitialState = {}) {
		this.dependencies = dependencies;
		this.undoStack.push(...(initialState.undoStack ?? []));
		this.redoStack.push(...(initialState.redoStack ?? []));
		this.historyPaused = initialState.historyPaused ?? false;
		this.locked = initialState.locked ?? false;
		this.lockedReason = initialState.recoveryReason;
		this.recoveryCompleted = initialState.recoveryCompleted ?? false;
	}

	cancelOperation(): boolean {
		if (this.activeScope === undefined || this.transaction?.cursorDurable) return false;
		this.activeScope.cancel();
		return true;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.cancelOperation();
		for (const scope of this.backgroundScopes) scope.cancel();
		await this.activeOperation;
		await this.cancelTree();
		await Promise.allSettled([...this.backgroundTasks, this.inputCommit, this.settling]);
		this.staged = undefined;
		this.finishRun(this.runCompletion);
		if (this.unsafeExit) throw new Error("process_exit_unconfirmed：旧任务未确认停止，不能重建 runtime");
	}

	private operationTimeout(): number {
		return this.dependencies.operationTimeoutMs ?? configuredTimeout("PI_UNDO_OPERATION_TIMEOUT_MS", 300_000);
	}

	private recordUnsafeExit(error: unknown): boolean {
		if (!isUnconfirmedExit(error) && !operationHasUnconfirmedExit()) return false;
		this.unsafeExit = true;
		this.lock("process_exit_unconfirmed");
		return true;
	}

	private runBackground<T>(body: () => Promise<T>): Promise<T> {
		const scope = createOperationScope({ timeoutMs: this.operationTimeout() });
		this.backgroundScopes.add(scope);
		const task = runWithOperationContext(scope.context, async () => {
			try {
				return await body();
			} finally {
				if (operationHasUnconfirmedExit()) this.recordUnsafeExit({ code: "process_exit_unconfirmed" });
			}
		}).finally(() => {
			scope.dispose();
			this.backgroundScopes.delete(scope);
			this.backgroundTasks.delete(task);
		});
		this.backgroundTasks.add(task);
		return task;
	}

	private async withRecoveryBudget<T>(body: () => Promise<T>): Promise<T> {
		try {
			return await withRecoveryBudget(body, {
				timeoutMs: this.operationTimeout(), onProgress: this.dependencies.onProgress,
			});
		} catch (error) {
			this.recordUnsafeExit(error);
			throw error;
		}
	}

	history(): HistoryState {
		return { undoCount: this.undoStack.length, redoCount: this.redoStack.length, locked: this.locked };
	}

	recoveryReason(): string | undefined {
		return this.locked ? this.lockedReason ?? "pending journal" : undefined;
	}

	private lock(reason: string): void {
		this.locked = true;
		if (this.lockedReason === undefined) {
			const normalized = truncateReason(reason);
			this.lockedReason = normalized.length === 0 ? "recovery_required" : normalized;
		}
	}

	private recoveryResult(changedFiles = 0): OperationResult {
		return {
			code: "recovery_required",
			changedFiles,
			message: this.recoveryReason(),
		};
	}

	captureFailed(): boolean {
		return this.lastCaptureFailed;
	}

	warmUp(): void {
		if (this.disposed || this.locked || this.warmUpInFlight !== undefined) return;
		this.warmUpInFlight = this.runBackground(async () => {
			try {
				this.warmUpManifest = await this.captureWithWorkspaceLock();
			} catch (error) {
				this.recordUnsafeExit(error);
				// 预热是 best-effort：失败静默，正式 capture 会再次尝试并上报。
			}
		});
	}

	captureFailureReason(): string | undefined {
		return this.lastCaptureFailed ? this.lastCaptureFailureMessage : undefined;
	}

	listCheckpoints(): readonly CheckpointRecord[] {
		return [...this.undoStack];
	}

	async prepareInput(text: string, context: InputContext): Promise<InputEventResult> {
		if (this.disposed || this.unsafeExit || this.promptDeferralInFlight) return { action: "defer" };
		if (this.locked) return { action: "continue" };
		if (this.operationInFlight) return { action: "defer" };
		if (context.streaming || text.length === 0) return { action: "continue" };
		if (this.disposed || this.runCompletion?.started || this.settling !== undefined) return { action: "defer" };
		const run = this.beginRun();
		try {
			const before = await this.runBackground(() => this.captureInputBaseline());
			if (this.runCompletion === run && !this.disposed) this.stageInput(text, before);
			return { action: "continue" };
		} catch (error) {
			// 无法证明输入前状态：放弃记录本次历史，但绝不吞掉用户输入。
			this.recordCaptureFailure(error);
			return { action: "continue" };
		}
	}

	beginInput(text: string, context: InputContext): InputEventResult {
		if (this.disposed || this.unsafeExit || this.promptDeferralInFlight) return { action: "defer" };
		if (this.locked) return { action: "continue" };
		if (this.operationInFlight) return { action: "defer" };
		if (context.streaming || text.length === 0) return { action: "continue" };
		if (this.disposed || this.runCompletion?.started || this.settling !== undefined) return { action: "defer" };
		this.beginRun();
		this.staged = undefined;
		this.lastCaptureFailed = false;
		this.lastCaptureFailureMessage = undefined;
		this.deferAgentStartUntilMessageEnd = true;
		const token = Symbol("input-capture");
		const promise = this.runBackground(() => this.captureInputForToken(text, token));
		this.pendingInputCapture = { token, promise };
		void promise.then(() => {
			if (this.pendingInputCapture?.token === token) this.pendingInputCapture = undefined;
		});
		return { action: "continue" };
	}

	commitInput(): Promise<void> {
		if (this.inputCommit !== undefined) return this.inputCommit;
		const commit = this.commitCapturedInput();
		this.inputCommit = commit.finally(() => { this.inputCommit = undefined; });
		return this.inputCommit;
	}

	private async commitCapturedInput(): Promise<void> {
		if (!this.deferAgentStartUntilMessageEnd || this.disposed) return;
		if (this.runCompletion !== undefined) this.runCompletion.started = true;
		const pending = this.pendingInputCapture;
		if (pending !== undefined) await pending.promise;
		this.pendingInputCapture = undefined;
		this.deferAgentStartUntilMessageEnd = false;
		await this.startAgentRun();
	}

	async beforeAgentStart(): Promise<void> {
		if (this.runCompletion !== undefined) this.runCompletion.started = true;
		if (this.deferAgentStartUntilMessageEnd) return;
		await this.startAgentRun();
	}

	private beginRun(): RunCompletion {
		this.finishRun(this.runCompletion);
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		const run = { started: false, promise, resolve };
		this.runCompletion = run;
		return run;
	}

	private finishRun(run: RunCompletion | undefined): void {
		if (this.runCompletion === run) this.runCompletion = undefined;
		run?.resolve();
	}

	private async startAgentRun(): Promise<void> {
		if (this.locked || this.disposed || this.staged === undefined) {
			this.finishRun(this.runCompletion);
			return;
		}
		const staged = this.staged;
		if (staged.startEntryId !== undefined) return;
		try {
			staged.startEntryId = await this.dependencies.appendControl("pi-undo:start", {
				schemaVersion: 1,
				beforeManifestId: staged.before.manifestId,
				sourceLogicalLeaf: staged.sourceLogicalLeaf,
			});
			if (this.staged.startEntryId === null) {
				this.lock("start_entry_missing");
				this.finishRun(this.runCompletion);
				this.staged = undefined;
				await this.dependencies.appendControl("pi-undo:barrier", { reason: "start_entry_missing" }).catch(() => {});
				return;
			}
		} catch {
			this.lock("start_entry_append_failed");
			this.finishRun(this.runCompletion);
			this.staged = undefined;
			return;
		}
		// 只有实际开始一个新 run 才会令 redo 分支失效；未启动的输入不会改变历史。
		this.redoStack.length = 0;
	}

	private async captureInputBaseline(): Promise<SnapshotManifest> {
		// warm-up 仍在进行时先等待，确保随后可以消费已完成的 baseline，而不是再次完整 capture。
		const warmUp = this.warmUpInFlight;
		if (warmUp !== undefined) await warmUp;
		const warmUpManifest = this.warmUpManifest;
		this.warmUpManifest = undefined;
		return warmUpManifest !== undefined && this.dependencies.captureBaseline !== undefined
			? this.captureBaselineWithWorkspaceLock(warmUpManifest)
			: this.captureWithWorkspaceLock();
	}

	private async captureInputForToken(text: string, token: symbol): Promise<void> {
		try {
			const before = await this.captureInputBaseline();
			if (this.pendingInputCapture?.token !== token) return;
			this.stageInput(text, before);
		} catch (error) {
			if (this.pendingInputCapture?.token !== token) return;
			// 无法证明输入前状态：放弃记录本次历史，但绝不吞掉用户输入。
			this.recordCaptureFailure(error);
		}
	}

	private stageInput(text: string, before: SnapshotManifest): void {
		this.lastCaptureFailed = false;
		this.lastCaptureFailureMessage = undefined;
		this.historyPaused = false;
		this.staged = { rawPrompt: text, before, sourceLogicalLeaf: this.dependencies.getLogicalLeafId() };
	}

	private recordCaptureFailure(error: unknown): void {
		this.lastCaptureFailed = true;
		this.recordUnsafeExit(error);
		this.lastCaptureFailureMessage = truncateReason(error instanceof Error ? error.message : String(error));
	}

	agentSettled(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.settling !== undefined) return this.settling;
		const run = this.runCompletion;
		const settled = this.runBackground(() => this.settleRun());
		this.settling = settled.finally(() => {
			this.settling = undefined;
			this.finishRun(run);
		});
		return this.settling;
	}

	private async settleRun(): Promise<void> {
		const staged = this.staged;
		this.staged = undefined;
		if (this.disposed || this.locked || staged === undefined) return;
		if (staged.startEntryId === undefined || staged.startEntryId === null) {
			// Pi 没有提供已落盘的 start entry ID，不能把后续 assistant 输出归属到该 checkpoint。
			this.lock("start_entry_missing");
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "start_entry_missing" }).catch(() => {});
			return;
		}
		const userEntryId = this.dependencies.findUserEntryAfter(staged.startEntryId);
		if (userEntryId === null) {
			this.lock("user_entry_missing");
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "user_entry_missing" }).catch(() => {});
			return;
		}
		const profiler = this.operationProfiler;
		const measure = <T>(phase: string, operation: () => Promise<T>): Promise<T> =>
			profiler === undefined ? operation() : profiler.measure(phase, operation);
		try {
			// settled 复用 run 开始时的 before；helper 在缺少 captureBaseline 时回退完整 capture。
			// 撕裂捕获（并发写撞上断言窗口）是暂态的：短暂退避后重试一次，成功则不清空历史。
			const after = await measure("settled.capture", () =>
				this.captureSettledBaselineWithRetry(staged.before));
			const changedPaths = await measure("settled.changedPaths", () =>
				this.dependencies.changedPaths(staged.before, after));
			if (changedPaths.length > 0 && this.dependencies.prepareDurableRestore !== undefined) {
				// /undo 在流式中断后正等待本次 settled；关键路径只预制立即使用的 after → before。
				const preparations = this.operationAction === "undo"
					? [measure("settled.prepareUndo", () =>
						this.dependencies.prepareDurableRestore!(after, staged.before, changedPaths))]
					: [
						measure("settled.prepareRedo", () =>
							this.dependencies.prepareDurableRestore!(staged.before, after, changedPaths)),
						measure("settled.prepareUndo", () =>
							this.dependencies.prepareDurableRestore!(after, staged.before, changedPaths)),
					];
				const outcomes = await Promise.allSettled(preparations);
				for (const outcome of outcomes) {
					if (outcome.status === "rejected" && this.recordUnsafeExit(outcome.reason)) throw outcome.reason;
				}
				checkOperation();
			}
			const endLeafId = this.dependencies.getLogicalLeafId() ?? staged.startEntryId;
			const checkpoint = this.createCheckpoint(staged, after, changedPaths, userEntryId, endLeafId);
			const checkpointEntryId = await measure("settled.checkpoint", () =>
				this.dependencies.appendControl("pi-undo:checkpoint", checkpoint));
			if (checkpointEntryId === null) {
				this.lock("checkpoint_entry_missing");
				await this.dependencies.appendControl("pi-undo:barrier", { reason: "checkpoint_entry_missing" }).catch(() => {});
				return;
			}
			this.undoStack.push(checkpoint);
		} catch (error) {
			this.recordUnsafeExit(error);
			this.historyPaused = true;
			this.undoStack.length = 0;
			this.redoStack.length = 0;
			await this.dependencies.appendControl("pi-undo:barrier", { reason: "settled_capture_failed" }).catch(() => {});
		}
	}

	async undo(): Promise<OperationResult> {
		if (this.locked) return this.recoveryResult();
		if (this.historyPaused) return { code: "history_paused", changedFiles: 0 };
		return this.runOperation("undo");
	}

	async redo(): Promise<OperationResult> {
		if (this.locked) return this.recoveryResult();
		if (this.historyPaused) return { code: "history_paused", changedFiles: 0 };
		// 新 run 开始时 redo frontier 已失效；空栈命令不得为了确认 noop 而中断正在运行的 Agent。
		if (this.redoStack.length === 0) return noop();
		return this.runOperation("redo");
	}

	beforeTree(event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined> {
		if (this.treeScope !== undefined) return Promise.resolve({ cancel: true });
		this.treeCancellationRequested = event.signal?.aborted ?? false;
		const scope = createOperationScope({ timeoutMs: this.operationTimeout(), signal: event.signal });
		this.treeScope = scope;
		const preparation = runWithOperationContext(scope.context, () => this.prepareTree(event));
		this.treePreparation = preparation.finally(() => {
			this.treePreparation = undefined;
			if (this.pendingTree === undefined) this.finishTreeScope();
		});
		return this.treePreparation;
	}

	private finishTreeScope(): void {
		this.treeScope?.dispose();
		this.treeScope = undefined;
	}

	private async prepareTree(event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined> {
		// Pi 0.86+ 在树导航期间也会让 isIdle() 暂时返回 false；只有 pi-undo
		// 已经记录了尚未 settle 的 run 时，才需要中止并取消导航。
		if (this.staged !== undefined || this.pendingInputCapture !== undefined ||
			this.runCompletion !== undefined || this.settling !== undefined || this.disposed) {
			await this.dependencies.abortAgent();
			return { cancel: true };
		}
		if (this.locked || this.historyPaused || this.operationInFlight || this.treeCancellationRequested) return { cancel: true };
		this.operationInFlight = true;
		let lease: { release(): Promise<void> } | undefined;
		try {
			checkOperation();
			lease = await this.dependencies.acquireWorkspaceLock();
			const rollback = await this.dependencies.capture();
			checkOperation();
			const targetState = await this.dependencies.resolveTreeTarget(event.targetLeafId);
			const target = await this.dependencies.loadManifest(targetState.targetManifestId);
			const plan = await this.dependencies.planRestore(rollback, target);
			const descriptor = this.createDescriptor("tree", rollback, target, plan, targetState.logicalLeafId);
			await this.dependencies.journal.prepare(descriptor, plan);
			this.pendingTree = { descriptor, rollback, target, plan, undoStack: targetState.undoStack, lease };
			if (this.treeCancellationRequested || this.treeScope?.context.signal.aborted) {
				await this.withRecoveryBudget(() => this.cancelPreparedTree());
				return { cancel: true };
			}
			return undefined;
		} catch (error) {
			this.recordUnsafeExit(error);
			if (lease !== undefined && !this.unsafeExit) {
				await lease.release().catch(() => { this.lock("workspace_lock_release_failed"); });
			}
			this.operationInFlight = false;
			return { cancel: true };
		}
	}

	afterTree(event: SessionTreeEvent): Promise<void> {
		if (this.treeApplication !== undefined) return this.treeApplication;
		const application = runWithOperationContext(this.treeScope?.context, () => this.applyPreparedTree(event));
		this.treeApplication = application.finally(() => {
			this.treeApplication = undefined;
			this.finishTreeScope();
		});
		return this.treeApplication;
	}

	private async applyPreparedTree(event: SessionTreeEvent): Promise<void> {
		const pending = this.pendingTree;
		if (pending === undefined) return;
		this.pendingTree = undefined;
		try {
			const navigationTarget = event.navigationTargetLeafId === undefined ? event.newLeafId : event.navigationTargetLeafId;
			if (navigationTarget !== pending.descriptor.toLogicalLeaf) {
				this.lock("session_navigation_diverged");
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.setJournalPhases(pending.descriptor.opId, [
				{ phase: "SESSION_MOVED", observedLogicalLeaf: event.newLeafId },
				{ phase: "APPLYING" },
			]);
			checkOperation();
			const applied = await this.dependencies.applyRestore(
				pending.plan,
				pending.target,
				{ opId: pending.descriptor.opId },
			);
			if (applied.code !== "ok") {
				this.lock("restore_failed");
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			checkOperation();
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "FILES_VERIFIED");
			const cursorResult = await this.dependencies.appendCursor(
				this.createTreeCursor(pending.descriptor, event.newLeafId, pending.undoStack),
			);
			if (cursorResult.kind !== "durable") {
				this.lock(cursorResult.kind === "recovery_required" ? cursorResult.reason : "cursor_recovery_required");
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "CURSOR_COMMITTED");
			await this.dependencies.journal.markCommitted(pending.descriptor.opId);
			this.undoStack.splice(0, this.undoStack.length, ...pending.undoStack);
			this.redoStack.length = 0;
		} catch (error) {
			this.recordUnsafeExit(error);
			this.lock("tree_recovery_failed");
		} finally {
			if (!this.unsafeExit && !operationHasUnconfirmedExit()) {
				await pending.lease.release().catch(() => { this.lock("workspace_lock_release_failed"); });
			}
			this.operationInFlight = false;
		}
	}

	async cancelTree(): Promise<void> {
		this.treeCancellationRequested = true;
		this.treeScope?.cancel();
		await this.treePreparation;
		await this.treeApplication;
		if (this.pendingTree !== undefined) await this.withRecoveryBudget(() => this.cancelPreparedTree());
		this.finishTreeScope();
	}

	private async cancelPreparedTree(): Promise<void> {
		const pending = this.pendingTree;
		if (pending === undefined) return;
		this.pendingTree = undefined;
		try {
			if (this.dependencies.getLogicalLeafId() !== pending.descriptor.fromLogicalLeaf) {
				this.lock("tree_cancel_session_moved");
				await this.dependencies.journal.setPhase(pending.descriptor.opId, "RECOVERY_REQUIRED");
				return;
			}
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "ABORTING");
			await this.dependencies.journal.setPhase(pending.descriptor.opId, "ABORTED");
		} catch (error) {
			this.recordUnsafeExit(error);
			this.lock("tree_cancel_failed");
		} finally {
			if (!this.unsafeExit && !operationHasUnconfirmedExit()) {
				await pending.lease.release().catch(() => { this.lock("workspace_lock_release_failed"); });
			}
			this.operationInFlight = false;
		}
	}

	async recover(): Promise<void> {
		if (this.recoveryCompleted) return;
		const recoveryInFlight = this.recoveryInFlight;
		if (recoveryInFlight !== undefined) {
			await recoveryInFlight;
			return;
		}
		const recovery = (async (): Promise<void> => {
			try {
				const result = await this.dependencies.recoverPending();
				if (result.kind === "locked") this.lock(result.reason ?? "recovery_failed");
			} catch {
				this.lock("recovery_failed");
			} finally {
				this.recoveryCompleted = true;
			}
		})();
		this.recoveryInFlight = recovery;
		await recovery;
	}

	private runOperation(action: "undo" | "redo"): Promise<OperationResult> {
		if (this.disposed || this.operationInFlight || this.activeOperation !== undefined) return Promise.resolve({ code: "busy", changedFiles: 0 });
		this.operationId = `op-${randomUUID()}`;
		this.dependencies.onOperationStart?.(this.operationId);
		const scope = createOperationScope({
			timeoutMs: this.operationTimeout(), onProgress: this.dependencies.onProgress, onProcess: this.dependencies.onProcess,
		});
		this.activeScope = scope;
		const opId = this.operationId;
		const task = runWithOperationContext(scope.context, () => this.performOperation(action)).then(async (result) => {
			await this.dependencies.onOperationEnd?.(opId, result).catch(() => {});
			return result;
		});
		this.activeOperation = task.finally(() => {
			scope.dispose();
			this.activeScope = undefined;
			this.activeOperation = undefined;
			this.transaction = undefined;
			this.operationId = undefined;
		});
		return this.activeOperation;
	}

	private async performOperation(action: "undo" | "redo"): Promise<OperationResult> {
		if (this.locked) return this.recoveryResult();
		if (this.operationInFlight) return { code: "busy", changedFiles: 0 };
		const profile = new OperationProfiler(this.dependencies.onProgress);
		const done = (result: OperationResult): OperationResult => profile.attach(result);
		this.operationInFlight = true;
		this.operationAction = action;
		this.operationProfiler = profile;
		this.promptDeferralInFlight = true;
		this.lastSafetyManifestId = null;
		let lease: { release(): Promise<void> } | undefined;
		try {
			if (!await profile.measure("idle", () => this.ensureIdle())) {
				checkOperation();
				return done({ code: "idle_timeout", changedFiles: 0 });
			}
			if (!await profile.measure("checkpoint", () => this.waitForCheckpoint())) {
				checkOperation();
				return done({ code: "idle_timeout", changedFiles: 0 });
			}
			if (this.locked) return done(this.recoveryResult());
			if (this.historyPaused) return done({ code: "history_paused", changedFiles: 0 });
			if (this.disposed) return done({ code: "busy", changedFiles: 0 });
			// Pi 空闲早于扩展 settled 完成；只有本轮完成凭据已终结才能选择目标。
			const redo = action === "redo" ? this.redoStack.at(-1) : undefined;
			const checkpoint = action === "undo" ? this.undoStack.at(-1) : redo?.checkpoint;
			if (checkpoint === undefined) return done(noop());
			const targetManifestId = redo?.targetManifestId;
			try {
				lease = await profile.measure("lock", () => this.dependencies.acquireWorkspaceLock());
			} catch (error) {
				if (operationFailure(error) !== undefined || isUnconfirmedExit(error)) throw error;
				return done({ code: "busy", changedFiles: 0 });
			}
			if (checkpoint.changedPaths.length === 0) {
				const result = await this.runSessionOnlyOperation(action, checkpoint, targetManifestId, profile);
				return done(this.advanceHistory(action, checkpoint, result));
			}
			const restoreTargetManifestId = targetManifestId ?? (
				action === "undo" ? checkpoint.beforeManifestId : checkpoint.afterManifestId
			);
			const referenceManifestId = action === "undo"
				? checkpoint.afterManifestId
				: checkpoint.beforeManifestId;
			let rollback: SnapshotManifest;
			try {
				rollback = await profile.measure("capture", () =>
					this.dependencies.captureSafety === undefined
						? this.dependencies.capture(checkpoint.changedPaths)
						: this.dependencies.captureSafety(
							referenceManifestId,
							restoreTargetManifestId,
							checkpoint.changedPaths,
						));
			} catch (error) {
				if (operationFailure(error) !== undefined || isUnconfirmedExit(error)) throw error;
				return done({ code: "capture_failed", changedFiles: 0 });
			}
			let target: SnapshotManifest;
			let plan: RestorePlan;
			let targetLogicalLeaf: string | null;
			try {
				target = await profile.measure("load", () =>
					this.dependencies.loadManifest(restoreTargetManifestId));
				plan = await profile.measure("plan", () =>
					this.dependencies.planRestore(rollback, target, checkpoint.changedPaths));
				targetLogicalLeaf = this.dependencies.resolveSessionTarget(action, checkpoint);
			} catch (error) {
				if (operationFailure(error) !== undefined || isUnconfirmedExit(error)) throw error;
				return done({ code: "restore_failed_safe", changedFiles: 0 });
			}
			const descriptor = this.createDescriptor(action, rollback, target, plan, targetLogicalLeaf);
			this.transaction = { descriptor, rollback, target, cursorDurable: false };
			await profile.measure("journal", () => this.dependencies.journal.prepare(descriptor, plan));
			const navigation = await profile.measure("navigate", () =>
				this.dependencies.navigateSession(action, checkpoint));
			if (navigation.cancelled) {
				await profile.measure("journal", async () => {
					await this.dependencies.journal.setPhase(descriptor.opId, "ABORTING");
					await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
				});
				return done({ code: "restore_failed_safe", changedFiles: 0 });
			}
			if (navigation.logicalLeafId !== descriptor.toLogicalLeaf) {
				this.lock("session_navigation_diverged");
				await profile.measure("journal", () =>
					this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED"));
				return done({ code: "recovery_required", changedFiles: 0 });
			}
			await profile.measure("journal", () => this.setJournalPhases(descriptor.opId, [
				{ phase: "SESSION_MOVED", observedLogicalLeaf: navigation.logicalLeafId },
				{ phase: "APPLYING" },
			]));
			const applied = await profile.measure("apply", () =>
				this.dependencies.applyRestore(plan, target, { opId: descriptor.opId }));
			if (applied.code !== "ok") {
				const result = await this.compensate(descriptor, rollback, target, applied);
				return done(result.code === "restore_failed_safe" && applied.failureCode !== undefined
					? { ...result, code: applied.failureCode } : result);
			}
			await profile.measure("journal", () =>
				this.dependencies.journal.setPhase(descriptor.opId, "FILES_VERIFIED"));
			const cursor = this.createCursor(descriptor, action, checkpoint);
			const cursorResult = await profile.measure("cursor", () => this.dependencies.appendCursor(cursor));
			if (cursorResult.kind === "recovery_required") {
				this.lock(cursorResult.reason);
				await profile.measure("journal", () =>
					this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {}));
				return done({ code: "recovery_required", changedFiles: applied.verifiedPaths });
			}
			if (cursorResult.kind === "volatile") {
				return done(await profile.measure("compensate", () => this.compensate(descriptor, rollback, target, {
					code: "recovery_required",
					verifiedPaths: applied.verifiedPaths,
					totalPaths: applied.totalPaths,
				})));
			}
			this.transaction.cursorDurable = true;
			await profile.measure("commit", async () => {
				await this.dependencies.journal.setPhase(descriptor.opId, "CURSOR_COMMITTED");
				await this.dependencies.journal.markCommitted(descriptor.opId);
			});
			this.lastSafetyManifestId = rollback.manifestId;
			return done(this.advanceHistory(action, checkpoint, { code: "ok", changedFiles: applied.verifiedPaths }));
		} catch (error) {
			if (this.recordUnsafeExit(error)) return done(this.recoveryResult());
			const reason = operationFailure(error);
			const tx = this.transaction;
			if (reason !== undefined && !tx?.cursorDurable) {
				if (tx !== undefined) {
					const recovered = tx.rollback !== undefined && tx.target !== undefined
						? await this.compensate(tx.descriptor, tx.rollback, tx.target, { code: "restore_failed_safe", verifiedPaths: 0, totalPaths: 0 })
						: await this.compensateSessionOnly(tx.descriptor);
					if (recovered.code === "recovery_required") return done(recovered);
				}
				return done({ code: reason, changedFiles: 0 });
			}
			this.lock("operation_failed");
			return done(this.recoveryResult());
		} finally {
			if (operationHasUnconfirmedExit()) this.recordUnsafeExit({ code: "process_exit_unconfirmed" });
			const activeLease = lease;
			if (activeLease !== undefined && !this.unsafeExit) {
				await profile.measure("unlock", () =>
					activeLease.release().catch(() => { this.lock("workspace_lock_release_failed"); }));
			}
			if (this.operationProfiler === profile) this.operationProfiler = undefined;
			this.operationAction = undefined;
			this.promptDeferralInFlight = false;
			this.operationInFlight = false;
		}
	}

	private advanceHistory(
		action: "undo" | "redo",
		checkpoint: CheckpointRecord,
		result: OperationResult,
	): OperationResult {
		if (result.code !== "ok") return result;
		if (action === "undo") {
			if (this.lastSafetyManifestId === null) return result;
			this.undoStack.pop();
			this.redoStack.push({ checkpoint, targetManifestId: this.lastSafetyManifestId });
			return { ...result, refillPrompt: checkpoint.rawPrompt };
		}
		this.redoStack.pop();
		this.undoStack.push(checkpoint);
		return result;
	}

	private async runSessionOnlyOperation(
		action: "undo" | "redo",
		checkpoint: CheckpointRecord,
		targetManifestId: ManifestId | undefined,
		profile: OperationProfiler,
	): Promise<OperationResult> {
		const rollbackManifestId = action === "undo"
			? checkpoint.afterManifestId
			: checkpoint.beforeManifestId;
		const targetId = targetManifestId ?? (
			action === "undo" ? checkpoint.beforeManifestId : checkpoint.afterManifestId
		);
		const plan = emptyRestorePlan(rollbackManifestId, targetId);
		const targetLogicalLeaf = this.dependencies.resolveSessionTarget(action, checkpoint);
		const descriptor = this.createDescriptorFromManifestIds(
			action,
			rollbackManifestId,
			targetId,
			plan,
			targetLogicalLeaf,
		);
		this.transaction = { descriptor, cursorDurable: false };
		await profile.measure("journal", () => this.dependencies.journal.prepare(descriptor, plan));
		const navigation = await profile.measure("navigate", () =>
			this.dependencies.navigateSession(action, checkpoint));
		if (navigation.cancelled) {
			await profile.measure("journal", async () => {
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTING");
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
			});
			return { code: "restore_failed_safe", changedFiles: 0 };
		}
		if (navigation.logicalLeafId !== descriptor.toLogicalLeaf) {
			this.lock("session_navigation_diverged");
			await profile.measure("journal", () =>
				this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED"));
			return { code: "recovery_required", changedFiles: 0 };
		}
		await profile.measure("journal", () => this.setJournalPhases(descriptor.opId, [
			{ phase: "SESSION_MOVED", observedLogicalLeaf: navigation.logicalLeafId },
			{ phase: "APPLYING" },
			{ phase: "FILES_VERIFIED" },
		]));
		const cursorResult = await profile.measure("cursor", () =>
			this.dependencies.appendCursor(this.createCursor(descriptor, action, checkpoint)));
		if (cursorResult.kind === "recovery_required") {
			this.lock(cursorResult.reason);
			await profile.measure("journal", () =>
				this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {}));
			return { code: "recovery_required", changedFiles: 0 };
		}
		if (cursorResult.kind === "volatile") {
			return profile.measure("compensate", () => this.compensateSessionOnly(descriptor));
		}
		this.transaction.cursorDurable = true;
		await profile.measure("commit", async () => {
			await this.dependencies.journal.setPhase(descriptor.opId, "CURSOR_COMMITTED");
			await this.dependencies.journal.markCommitted(descriptor.opId);
		});
		this.lastSafetyManifestId = rollbackManifestId;
		return { code: "ok", changedFiles: 0 };
	}

	private async compensateSessionOnly(descriptor: OperationDescriptor): Promise<OperationResult> {
		try {
			return await this.withRecoveryBudget(() => this.compensateSessionOnlyWithinBudget(descriptor));
		} catch {
			this.lock("session_only_recovery_failed");
			return this.recoveryResult();
		}
	}

	private async compensateSessionOnlyWithinBudget(descriptor: OperationDescriptor): Promise<OperationResult> {
		try {
			await this.dependencies.journal.setPhase(descriptor.opId, "ABORTING");
			if (!await this.dependencies.restoreSessionLeaf(descriptor.fromLogicalLeaf)) {
				throw new Error("session rollback failed");
			}
			await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
			return { code: "restore_failed_safe", changedFiles: 0 };
		} catch {
			this.lock("session_only_recovery_failed");
			await this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {});
			return this.recoveryResult();
		}
	}

	private async setJournalPhases(
		opId: string,
		transitions: ReadonlyArray<{
			readonly phase: Parameters<JournalPort["setPhase"]>[1];
			readonly observedLogicalLeaf?: string | null;
		}>,
	): Promise<void> {
		if (this.dependencies.journal.setPhases !== undefined) {
			await this.dependencies.journal.setPhases(opId, transitions);
			return;
		}
		for (const transition of transitions) {
			await this.dependencies.journal.setPhase(opId, transition.phase, {
				...(transition.observedLogicalLeaf === undefined
					? {}
					: { observedLogicalLeaf: transition.observedLogicalLeaf }),
			});
		}
	}

	private async waitForCheckpoint(): Promise<boolean> {
		const deadline = currentOperationContext()?.deadline ?? Date.now() + this.operationTimeout();
		for (const task of [this.pendingInputCapture?.promise, this.inputCommit]) {
			if (task !== undefined && !await waitForCompletion(task, deadline)) return false;
		}
		const run = this.runCompletion;
		if (run?.started) return waitForCompletion(run.promise, deadline);
		// 输入预检失败时没有 message_end/settled；候选快照不属于已启动的 run。
		this.staged = undefined;
		this.deferAgentStartUntilMessageEnd = false;
		this.finishRun(run);
		return true;
	}

	private async ensureIdle(): Promise<boolean> {
		if (this.dependencies.isAgentIdle()) return true;
		try {
			await this.dependencies.abortAgent();
			return await this.dependencies.waitForIdle(this.dependencies.clock() + 30_000);
		} catch (error) {
			rethrowOperationFailure(error);
			return false;
		}
	}

	private async captureWithWorkspaceLock(): Promise<SnapshotManifest> {
		// 预热可能仍持有 workspace lock：先等它完成再 acquire，避免排队超时；
		// 此时进程内缓存已暖，本次 capture 只需指纹校验。
		const warmUp = this.warmUpInFlight;
		if (warmUp !== undefined) await warmUp;
		const lease = await this.dependencies.acquireWorkspaceLock();
		try {
			return await this.dependencies.capture();
		} catch (error) {
			this.recordUnsafeExit(error);
			throw error;
		} finally {
			if (!this.unsafeExit) await lease.release();
		}
	}

	private async captureBaselineWithWorkspaceLock(baseline: SnapshotManifest): Promise<SnapshotManifest> {
		const captureBaseline = this.dependencies.captureBaseline;
		if (captureBaseline === undefined) return this.captureWithWorkspaceLock();
		const lease = await this.dependencies.acquireWorkspaceLock();
		try {
			return await captureBaseline(baseline);
		} catch (error) {
			this.recordUnsafeExit(error);
			throw error;
		} finally {
			if (!this.unsafeExit) await lease.release();
		}
	}

	/**
	 * settled capture 对暂态失败重试一次：async subagent 等并发写入者可能撞上撕裂断言
	 * （捕获期间叶子变化）或短暂持有 workspace lock。settled 失败会清空整个 undo 历史，
	 * 不能因一次暂态冲突就放弃；持续失败仍由调用方走原有 historyPaused 路径。
	 */
	private async captureSettledBaselineWithRetry(baseline: SnapshotManifest): Promise<SnapshotManifest> {
		try {
			return await this.captureBaselineWithWorkspaceLock(baseline);
		} catch (error) {
			rethrowOperationFailure(error);
			if (!isTransientCaptureFailure(error)) throw error;
			await sleep(250);
			return await this.captureBaselineWithWorkspaceLock(baseline);
		}
	}

	private async compensate(
		descriptor: OperationDescriptor,
		rollback: SnapshotManifest,
		target: SnapshotManifest,
		failure: RestoreResult,
	): Promise<OperationResult> {
		try {
			this.dependencies.onProgress?.("compensate");
			return await this.withRecoveryBudget(() => this.compensateWithinBudget(descriptor, rollback, target, failure));
		} catch {
			this.lock("compensation_failed");
			return this.recoveryResult();
		}
	}

	private async compensateWithinBudget(
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
			const reverted = await this.dependencies.applyRestore(
				rollbackPlan,
				rollback,
				{ opId: descriptor.opId },
			);
			if (reverted.code === "ok") {
				await this.dependencies.journal.setPhase(descriptor.opId, "ABORTED");
				return { code: "restore_failed_safe", changedFiles: failure.verifiedPaths };
			}
		} catch (error) {
			this.recordUnsafeExit(error);
			// 下面统一进入 recovery lock。
		}
		this.lock("compensation_failed");
		await this.dependencies.journal.setPhase(descriptor.opId, "RECOVERY_REQUIRED").catch(() => {});
		return this.recoveryResult(failure.verifiedPaths);
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
		return this.createDescriptorFromManifestIds(
			action,
			rollback.manifestId,
			target.manifestId,
			plan,
			targetLogicalLeaf,
		);
	}

	private createDescriptorFromManifestIds(
		action: "undo" | "redo" | "tree",
		rollbackManifestId: ManifestId,
		targetManifestId: ManifestId,
		plan: RestorePlan,
		targetLogicalLeaf: string | null,
	): OperationDescriptor {
		const scopePaths = [...(plan.scopePaths ?? [...plan.deletePaths, ...plan.writePaths])].sort();
		const payload = {
			schemaVersion: 1 as const,
			opId: this.operationId ?? `op-${randomUUID()}`,
			sessionIdentity: this.dependencies.sessionIdentity,
			workspaceIdentity: this.dependencies.workspaceIdentity,
			action,
			fromLogicalLeaf: this.dependencies.getLogicalLeafId(),
			toLogicalLeaf: targetLogicalLeaf,
			targetManifestId,
			rollbackManifestId,
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

function emptyRestorePlan(currentManifestId: ManifestId, targetManifestId: ManifestId): RestorePlan {
	const payload = {
		currentManifestId,
		targetManifestId,
		boundaryRoots: [],
		deletePaths: [],
		writePaths: [],
		scopePaths: [],
	};
	return { ...payload, planDigest: checksum(canonicalJson(payload)) };
}

class OperationProfiler {
	private readonly durations = new Map<string, number>();

	constructor(private readonly onProgress?: (phase: string) => void) {}

	async measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
		if (phase !== "unlock" && phase !== "commit" && !phase.startsWith("settled.")) checkOperation();
		this.onProgress?.(phase);
		const started = performance.now();
		try {
			return await operation();
		} finally {
			this.durations.set(phase, (this.durations.get(phase) ?? 0) + performance.now() - started);
		}
	}

	attach(result: OperationResult): OperationResult {
		const total = [...this.durations.values()].reduce((sum, duration) => sum + duration, 0);
		if (total < 1_000) return result;
		return {
			...result,
			timings: [...this.durations].map(([phase, durationMs]) => ({
				phase,
				durationMs: Math.round(durationMs),
			})),
		};
	}
}

async function waitForCompletion(task: Promise<void>, deadline: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const signal = currentOperationContext()?.signal;
	let onAbort: (() => void) | undefined;
	try {
		checkOperation();
		return await Promise.race([
			task.then(() => true, () => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
				onAbort = () => resolve(false);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

function noop(): OperationResult {
	return { code: "noop", changedFiles: 0 };
}

function truncateReason(reason: string): string {
	return reason.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 120);
}

/**
 * 判断 capture 失败是否为并发写入者导致的暂态失败：撕裂断言
 * （SnapshotStoreError capture_failed，如“捕获期间工作区叶子已变化”）与
 * workspace lock 超时（WorkspaceLockError lock_timeout）。用 name/code 鸭子类型
 * 判断以保持 controller 对存储实现的解耦。
 */
function isTransientCaptureFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code } = error as { name?: unknown; code?: unknown };
	return (name === "SnapshotStoreError" && code === "capture_failed") ||
		(name === "WorkspaceLockError" && code === "lock_timeout");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
