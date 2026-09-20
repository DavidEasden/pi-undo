import { AsyncLocalStorage } from "node:async_hooks";

export type OperationErrorCode = "operation_cancelled" | "operation_timeout";

/**
 * 一次可取消操作的共享作用域。调用方（撤回/捕获/恢复入口）创建 context，
 * 低层只读取当前继承的 context：deadline 是硬上限，signal 是取消通道。
 */
export interface ProcessDiagnostic {
	readonly command: string;
	readonly durationMs: number;
	readonly outcome: string;
	readonly exitCode: number | null;
}

export interface OperationContext {
	readonly signal: AbortSignal;
	readonly deadline: number;
	readonly onProgress?: (phase: string) => void;
	readonly onProcess?: (diagnostic: ProcessDiagnostic) => void;
}

export class OperationError extends Error {
	readonly code: OperationErrorCode;

	constructor(code: OperationErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OperationError";
		this.code = code;
	}
}

/** 超时与主动取消都走 AbortSignal；用固定 reason 区分两者。 */
const OPERATION_TIMEOUT_REASON = "operation_timeout";

const storage = new AsyncLocalStorage<OperationContext | undefined>();
const unsafeContexts = new WeakSet<OperationContext>();

export function markProcessExitUnconfirmed(): void {
	const context = storage.getStore();
	if (context !== undefined) unsafeContexts.add(context);
}

export function operationHasUnconfirmedExit(): boolean {
	const context = storage.getStore();
	return context !== undefined && unsafeContexts.has(context);
}

/**
 * 在 context 下运行 body；context 为 undefined 时清除继承的 context，
 * 保证嵌套作用域之间不会泄漏取消状态。
 */
export function runWithOperationContext<T>(context: OperationContext | undefined, body: () => T): T {
	return storage.run(context, body);
}

export function currentOperationContext(): OperationContext | undefined {
	return storage.getStore();
}

/**
 * 取消或超时检查：可在任意 await 边界调用。没有 context 时是空操作。
 * 已取消/超时抛 OperationError，code 区分 operation_cancelled 与 operation_timeout。
 */
export function checkOperation(): void {
	const context = storage.getStore();
	if (context === undefined) {
		return;
	}
	if (unsafeContexts.has(context)) throw Object.assign(new Error("子进程未确认退出"), { code: "process_exit_unconfirmed" });
	if (context.signal.aborted) {
		throw operationErrorFromAbortReason(context.signal.reason);
	}
	if (Date.now() >= context.deadline) {
		throw new OperationError("operation_timeout", "操作超过截止时间");
	}
}

/** 报告可读阶段（供状态显示使用）；没有 context 或没有 onProgress 时是空操作。 */
export function reportOperationProgress(phase: string): void {
	storage.getStore()?.onProgress?.(phase);
}

export function reportProcessDiagnostic(diagnostic: ProcessDiagnostic): void {
	try {
		storage.getStore()?.onProcess?.(diagnostic);
	} catch {
		// 诊断失败不能改变事务结果。
	}
}

export interface OperationProcessOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
}

/**
 * 低层子进程包装器使用的预算：取「剩余 deadline」与 defaultTimeoutMs 的较小值。
 * 已取消或已超时直接抛出，避免取消后继续启动新工作。
 */
export function operationProcessOptions(defaultTimeoutMs = 120_000): OperationProcessOptions {
	if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 0) {
		throw new RangeError("defaultTimeoutMs 必须是非负有限数字");
	}
	const context = storage.getStore();
	if (context === undefined) {
		return { timeoutMs: defaultTimeoutMs };
	}
	checkOperation();
	const remaining = context.deadline - Date.now();
	return {
		signal: context.signal,
		timeoutMs: Math.min(defaultTimeoutMs, remaining),
	};
}

export interface OperationScopeOptions {
	/** 不传表示没有 deadline（只受 signal 控制）。 */
	readonly timeoutMs?: number;
	/** 上层取消（例如 /undo-cancel 或父作用域）会传播到本作用域。 */
	readonly signal?: AbortSignal;
	readonly onProgress?: (phase: string) => void;
	readonly onProcess?: (diagnostic: ProcessDiagnostic) => void;
	readonly now?: () => number;
}

export interface OperationScope {
	readonly context: OperationContext;
	/** 请求主动取消。 */
	cancel(): void;
	/** 清除超时计时器与父 signal 监听。 */
	dispose(): void;
}

/**
 * 创建一次可取消操作的 context。超时通过计时器把 signal 置为 timeout reason，
 * 使 checkOperation/operationProcessOptions 能区分超时与主动取消。
 */
export function createOperationScope(options: OperationScopeOptions = {}): OperationScope {
	const now = options.now ?? Date.now;
	const controller = new AbortController();
	const deadline = options.timeoutMs === undefined
		? Number.POSITIVE_INFINITY
		: now() + options.timeoutMs;
	let timeout: NodeJS.Timeout | undefined;
	if (options.timeoutMs !== undefined) {
		timeout = setTimeout(() => controller.abort(OPERATION_TIMEOUT_REASON), Math.max(0, options.timeoutMs));
		timeout.unref();
	}
	const onParentAbort = (): void => controller.abort(options.signal?.reason ?? "operation_cancelled");
	if (options.signal !== undefined) {
		if (options.signal.aborted) {
			onParentAbort();
		} else {
			options.signal.addEventListener("abort", onParentAbort, { once: true });
		}
	}
	const context: OperationContext = {
		signal: controller.signal,
		deadline,
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options.onProcess === undefined ? {} : { onProcess: options.onProcess }),
	};
	return {
		context,
		cancel: () => controller.abort("operation_cancelled"),
		dispose: () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			options.signal?.removeEventListener("abort", onParentAbort);
		},
	};
}

export async function allCompleted<T extends readonly unknown[]>(tasks: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	const outcomes = await Promise.allSettled(tasks);
	const failure = outcomes.find((outcome) => outcome.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}

export function configuredTimeout(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} 必须是正整数毫秒`);
	return value;
}

export async function withRecoveryBudget<T>(body: () => Promise<T>, options: OperationScopeOptions = {}): Promise<T> {
	if (operationHasUnconfirmedExit()) checkOperation();
	const scope = createOperationScope({
		timeoutMs: configuredTimeout("PI_UNDO_OPERATION_TIMEOUT_MS", 300_000),
		onProcess: currentOperationContext()?.onProcess,
		...options,
	});
	try {
		return await runWithOperationContext(scope.context, async () => {
			try {
				return await body();
			} finally {
				if (operationHasUnconfirmedExit()) checkOperation();
			}
		});
	} catch (error) {
		if (isUnconfirmedExit(error)) markProcessExitUnconfirmed();
		throw error;
	} finally {
		scope.dispose();
	}
}

export function isUnconfirmedExit(error: unknown): boolean {
	return errorChain(error).some((value) => value.code === "git_termination_failed" || value.code === "process_exit_unconfirmed");
}

/** 包装层保留 cause 时仍能识别取消，避免被误报为普通 capture 失败。 */
export function operationFailure(error: unknown): OperationErrorCode | undefined {
	for (const value of errorChain(error)) {
		if (value.code === "operation_cancelled" || value.code === "operation_timeout") return value.code;
		const result = value.result as { timedOut?: boolean; aborted?: boolean } | undefined;
		if (result?.timedOut) return "operation_timeout";
		if (result?.aborted) return "operation_cancelled";
	}
	return undefined;
}

export function rethrowOperationFailure(error: unknown): void {
	if (isUnconfirmedExit(error) || operationFailure(error) !== undefined) throw error;
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
	const chain: Array<Record<string, unknown>> = [];
	const seen = new Set<unknown>();
	while (typeof error === "object" && error !== null && !seen.has(error)) {
		seen.add(error);
		const value = error as Record<string, unknown>;
		chain.push(value);
		error = value.cause;
	}
	return chain;
}

function operationErrorFromAbortReason(reason: unknown): OperationError {
	if (isTimeoutReason(reason)) {
		return new OperationError("operation_timeout", "操作超过截止时间");
	}
	return new OperationError("operation_cancelled", "操作已被取消");
}

/** 判断 AbortSignal 的 reason 是否代表超时（而不是主动取消）。 */
export function isOperationTimeoutReason(reason: unknown): boolean {
	return isTimeoutReason(reason);
}

function isTimeoutReason(reason: unknown): boolean {
	if (reason === OPERATION_TIMEOUT_REASON) {
		return true;
	}
	if (typeof reason !== "object" || reason === null) {
		return false;
	}
	const value = reason as { readonly code?: unknown; readonly name?: unknown };
	return value.code === OPERATION_TIMEOUT_REASON || value.name === "TimeoutError";
}
