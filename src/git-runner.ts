import { spawn, type ChildProcess } from "node:child_process";

import { type OperationContext, configuredTimeout, currentOperationContext, isOperationTimeoutReason, markProcessExitUnconfirmed, reportProcessDiagnostic } from "./operation-context.ts";

export const DEFAULT_STDERR_LIMIT = 64 * 1024;
/** Git 单次调用的默认预算；调用链上的 deadline 可进一步收紧它。 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 50;
const PROCESS_TREE_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_TREE_POLL_MS = 10;
const TASKKILL_TIMEOUT_MS = 5_000;
const activeProcessGroups = new Set<number>();

process.once("exit", () => {
	for (const processGroup of activeProcessGroups) {
		try {
			process.kill(-processGroup, "SIGKILL");
		} catch {
			// 进程组已经结束时无需处理。
		}
	}
});

export interface GitRunOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stdin?: string | Uint8Array;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly stderrLimit?: number;
}

export interface GitRunResult {
	readonly stdout: string;
	readonly stdoutBytes: Uint8Array;
	readonly stderr: string;
	readonly code: number | null;
	readonly killed: boolean;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}

export type GitRunErrorCode = "git_failed" | "git_spawn_failed" | "git_termination_failed";

export class GitRunError extends Error {
	readonly code: GitRunErrorCode;
	readonly result?: GitRunResult;

	constructor(code: GitRunErrorCode, message: string, result?: GitRunResult) {
		super(message);
		this.name = "GitRunError";
		this.code = code;
		this.result = result;
	}
}

export interface GitRunner {
	run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult>;
}

export class GitRunner {
	async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		const started = performance.now();
		// 仅记录已知子命令名，不保留路径、环境、stdin 或 stderr。
		const commands = new Set(["cat-file", "ls-files", "ls-tree", "hash-object", "read-tree", "write-tree", "update-index", "rev-parse", "check-ignore", "config", "init"]);
		const command = `git:${args.find((argument) => commands.has(argument)) ?? "other"}`;
		let outcome = "failed";
		let exitCode: number | null = null;
		try {
			const result = await this.runCommand(args, options);
			outcome = result.timedOut ? "timeout" : result.aborted ? "cancelled" : "exit";
			exitCode = result.code;
			return result;
		} catch (error) {
			if (error instanceof GitRunError) {
				outcome = error.code;
				exitCode = error.result?.code ?? null;
			}
			throw error;
		} finally {
			reportProcessDiagnostic({ command, durationMs: Math.round(performance.now() - started), outcome, exitCode });
		}
	}

	private async runCommand(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
		const stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
		if (!Number.isInteger(stderrLimit) || stderrLimit < 0) {
			throw new RangeError("stderrLimit 必须是非负整数");
		}
		if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
			throw new RangeError("timeoutMs 必须是非负有限数字");
		}
		const context = currentOperationContext();
		const signal = combineAbortSignals(options.signal, context?.signal);
		const budget = resolveTimeoutBudget(options.timeoutMs, context);
		if (signal?.aborted === true) {
			const timedOut = isOperationTimeoutReason(signal.reason);
			return killedResult({ aborted: !timedOut, timedOut });
		}
		if (budget.expired) {
			return killedResult({ aborted: false, timedOut: true });
		}

		return new Promise<GitRunResult>((resolve, reject) => {
			const environment = mergeEnvironment(options.env);
			let child;
			try {
				child = spawn("git", [...args], {
					cwd: options.cwd,
					detached: process.platform !== "win32",
					env: environment,
					shell: false,
					stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				});
			} catch (error) {
				reject(new GitRunError("git_spawn_failed", errorMessage(error)));
				return;
			}
			trackProcessGroup(child);

			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stderrBytes = 0;
			let killed = false;
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let forceKill: NodeJS.Timeout | undefined;
			let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
			let terminationFinalized = false;
			let terminationFailed = false;

			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				if (stderrBytes >= stderrLimit) {
					return;
				}
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const remaining = stderrLimit - stderrBytes;
				const captured = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
				stderr.push(captured);
				stderrBytes += captured.length;
			});
			if (options.stdin !== undefined) {
				child.stdin?.end(typeof options.stdin === "string" ? options.stdin : Buffer.from(options.stdin));
			}

			const finishTermination = (stopped: boolean): void => {
				terminationFailed = !stopped;
				terminationFinalized = true;
				finish();
			};

			const terminate = (reason: "timeout" | "abort"): void => {
				if (settled || killed) {
					return;
				}
				killed = true;
				timedOut = reason === "timeout";
				aborted = reason === "abort";
				signalProcessTree(child, "SIGTERM");
				// 宽限期后升级为 SIGKILL，并确认进程组真的退出；只有确认后才结束 Promise，
				// 否则上层无法安全释放 lease。
				forceKill = setTimeout(() => {
					void forceTerminateProcessTree(child).then(finishTermination);
				}, TERMINATION_GRACE_MS);
			};

			const onAbort = (): void => terminate(isOperationTimeoutReason(signal?.reason) ? "timeout" : "abort");
			const cleanUp = (): void => {
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				if (forceKill) {
					clearTimeout(forceKill);
				}
				if (!terminationFailed) untrackProcessGroup(child);
				signal?.removeEventListener("abort", onAbort);
			};

			const finish = (): void => {
				if (settled) {
					return;
				}
				// 被终止时先等终止确认；确认进程组已退出后即便 close 一直不到达也必须结束，
				// 避免强杀后无限等待 close。
				if (killed && !terminationFinalized) {
					return;
				}
				if (closeResult === undefined && !terminationFinalized) {
					return;
				}
				cleanUp();
				const exit = closeResult ?? { code: null, signal: null };
				const stdoutBuffer = Buffer.concat(stdout);
				const result: GitRunResult = {
					stdout: stdoutBuffer.toString("utf8"),
					stdoutBytes: new Uint8Array(stdoutBuffer),
					stderr: Buffer.concat(stderr).toString("utf8"),
					code: exit.code,
					killed: killed || exit.signal !== null,
					timedOut,
					aborted,
				};
				if (terminationFailed) {
					markProcessExitUnconfirmed();
					reject(new GitRunError("git_termination_failed", "Git 进程组未能完全终止", result));
					return;
				}
				if (!killed && exit.code !== 0) {
					reject(new GitRunError("git_failed", `git 退出码为 ${String(exit.code)}`, result));
					return;
				}
				resolve(result);
			};

			child.once("error", (error) => {
				if (settled) {
					return;
				}
				cleanUp();
				reject(new GitRunError("git_spawn_failed", error.message));
			});

			child.once("close", (code, signalValue) => {
				if (settled) {
					return;
				}
				closeResult = { code, signal: signalValue };
				if (!killed && signalValue !== null) {
					// 父进程被外部信号终止时也清理后代，避免其在失败返回后继续写入。
					void forceTerminateProcessTree(child).then(finishTermination);
					return;
				}
				if (!killed) {
					terminationFinalized = true;
				}
				finish();
			});

			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			timeout = setTimeout(() => terminate("timeout"), budget.timeoutMs);
		});
	}
}

/** 终止共享子进程：先 SIGTERM，宽限期后 SIGKILL，并返回进程组是否已确认退出。 */
async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
	signalProcessTree(child, "SIGTERM");
	if (await waitForProcessTreeExit(child, TERMINATION_GRACE_MS)) {
		return true;
	}
	return forceTerminateProcessTree(child);
}

async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
	if (process.platform === "win32" && child.pid !== undefined) {
		const taskkilled = await runTaskkill(child.pid);
		if (!taskkilled) {
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经退出时无需处理。
			}
		}
		if (taskkilled) return waitForProcessTreeExit(child, PROCESS_TREE_EXIT_TIMEOUT_MS);
		await waitForProcessTreeExit(child, PROCESS_TREE_EXIT_TIMEOUT_MS);
		// 只证明父进程退出不足以证明其后代退出。
		return false;
	}
	signalProcessTree(child, "SIGKILL");
	return waitForProcessTreeExit(child, PROCESS_TREE_EXIT_TIMEOUT_MS);
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (processTreeExitConfirmed(child)) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(PROCESS_TREE_POLL_MS);
	}
}

function processTreeExitConfirmed(child: ChildProcess): boolean {
	if (process.platform === "win32") {
		return child.exitCode !== null || child.signalCode !== null;
	}
	if (child.pid === undefined) {
		return true;
	}
	return !processGroupExists(child.pid);
}

function runTaskkill(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const finish = (killed: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolve(killed);
		};
		// taskkill 本身也可能挂住；超时后放弃它并回退到直接 SIGKILL。
		const timeout = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经退出时无需处理。
			}
			finish(false);
		}, TASKKILL_TIMEOUT_MS);
		timeout.unref();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

function processGroupExists(processGroup: number): boolean {
	try {
		process.kill(-processGroup, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function trackProcessGroup(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		activeProcessGroups.add(child.pid);
	}
}

function untrackProcessGroup(child: ChildProcess): void {
	if (child.pid !== undefined) {
		activeProcessGroups.delete(child.pid);
	}
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if (!hasErrorCode(error, "ESRCH")) {
				child.kill(signal);
			}
			return;
		}
	}
	child.kill(signal);
}

export interface SupervisedProcessRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
	readonly outputLimitBytes: number;
	/** 输出超过限制时：truncate 只停止捕获，terminate 先终止进程组。 */
	readonly outputOverflow?: "truncate" | "terminate";
}

export interface SupervisedProcessResult {
	readonly outcome: "exit" | "timeout" | "cancelled" | "output_overflow";
	readonly code: number | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	/** 非 exit 结果下进程组是否已确认退出；false 表示调用方必须保留 lease。 */
	readonly stopped: boolean;
}

/**
 * native helper 等非 Git 子进程共用同一套进程组终止语义：超时/取消先终止进程组，
 * 确认退出后才返回，避免"已取消但仍在后台写入"。
 */
export async function runSupervisedProcess(request: SupervisedProcessRequest): Promise<SupervisedProcessResult> {
	const started = performance.now();
	let outcome = "failed";
	let exitCode: number | null = null;
	try {
		const result = await superviseProcess(request);
		outcome = result.stopped ? result.outcome : "process_exit_unconfirmed";
		exitCode = result.code;
		return result;
	} finally {
		reportProcessDiagnostic({ command: "native-helper", durationMs: Math.round(performance.now() - started), outcome, exitCode });
	}
}

function superviseProcess(request: SupervisedProcessRequest): Promise<SupervisedProcessResult> {
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) {
		return Promise.reject(new RangeError("timeoutMs 必须是非负有限数字"));
	}
	if (!Number.isInteger(request.outputLimitBytes) || request.outputLimitBytes < 0) {
		return Promise.reject(new RangeError("outputLimitBytes 必须是非负整数"));
	}
	if (request.signal?.aborted === true) {
		return Promise.resolve({
			outcome: "cancelled",
			code: null,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
			stopped: true,
		});
	}
	return new Promise<SupervisedProcessResult>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env: mergeEnvironment(request.env),
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return;
		}
		trackProcessGroup(child);

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let outcome: SupervisedProcessResult["outcome"] = "exit";
		let closeCode: number | null = null;
		let closeArrived = false;
		let stopped = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let termination: Promise<boolean> | undefined;

		const cleanUp = (): void => {
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			if (outcome === "exit" || stopped) untrackProcessGroup(child);
			request.signal?.removeEventListener("abort", onAbort);
		};

		const finish = (): void => {
			if (settled) {
				return;
			}
			cleanUp();
			resolve({
				outcome,
				code: closeCode,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				stopped: outcome === "exit" ? closeArrived : stopped,
			});
		};

		const beginTermination = (reason: SupervisedProcessResult["outcome"]): void => {
			if (settled || termination !== undefined || outcome !== "exit") {
				return;
			}
			outcome = reason;
			termination = terminateProcessTree(child).then((value) => {
				if (!value) markProcessExitUnconfirmed();
				stopped = value;
				finish();
				return value;
			});
		};

		function onAbort(): void {
			beginTermination("cancelled");
		}

		const capture = (target: Buffer[]) => (chunk: Buffer | string): void => {
			if (settled) {
				return;
			}
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = request.outputLimitBytes - outputBytes;
			if (bytes.length > remaining) {
				if (remaining > 0) {
					target.push(bytes.subarray(0, remaining));
					outputBytes += remaining;
				}
				if (request.outputOverflow === "terminate") {
					beginTermination("output_overflow");
				} else {
					outputBytes = request.outputLimitBytes;
				}
				return;
			}
			target.push(bytes);
			outputBytes += bytes.length;
		};
		child.stdout?.on("data", capture(stdout));
		child.stderr?.on("data", capture(stderr));

		child.once("error", (error) => {
			if (settled) {
				return;
			}
			cleanUp();
			reject(error);
		});
		child.once("close", (code) => {
			closeCode = code;
			closeArrived = true;
			if (termination === undefined) {
				finish();
			}
		});

		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) onAbort();
		timeout = setTimeout(() => beginTermination("timeout"), request.timeoutMs);
	});
}

export function createGitRunner(): GitRunner {
	return new GitRunner();
}

function killedResult(options: { readonly aborted: boolean; readonly timedOut: boolean }): GitRunResult {
	return {
		stdout: "",
		stdoutBytes: new Uint8Array(),
		stderr: "",
		code: null,
		killed: true,
		timedOut: options.timedOut,
		aborted: options.aborted,
	};
}

/** context.signal 与调用方 signal 都要能终止子进程；两者取并集。 */
function combineAbortSignals(
	own: AbortSignal | undefined,
	context: AbortSignal | undefined,
): AbortSignal | undefined {
	if (own === undefined) {
		return context;
	}
	if (context === undefined || own === context) {
		return own;
	}
	return AbortSignal.any([own, context]);
}

function resolveTimeoutBudget(
	explicitTimeoutMs: number | undefined,
	context: OperationContext | undefined,
): { readonly timeoutMs: number; readonly expired: boolean } {
	const defaultTimeoutMs = configuredTimeout("PI_UNDO_GIT_TIMEOUT_MS", DEFAULT_GIT_TIMEOUT_MS);
	if (context === undefined) {
		return { timeoutMs: explicitTimeoutMs ?? defaultTimeoutMs, expired: false };
	}
	const remaining = context.deadline - Date.now();
	if (remaining <= 0) {
		return { timeoutMs: 0, expired: true };
	}
	const timeoutMs = explicitTimeoutMs === undefined
		? Math.min(defaultTimeoutMs, remaining)
		: Math.min(explicitTimeoutMs, remaining);
	return { timeoutMs, expired: false };
}

function mergeEnvironment(overrides: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	}
	return environment;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
