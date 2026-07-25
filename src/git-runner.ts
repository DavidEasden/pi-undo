import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_STDERR_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 50;
const PROCESS_TREE_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_TREE_POLL_MS = 10;
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
		const stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
		if (!Number.isInteger(stderrLimit) || stderrLimit < 0) {
			throw new RangeError("stderrLimit 必须是非负整数");
		}
		if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
			throw new RangeError("timeoutMs 必须是非负有限数字");
		}
		if (options.signal?.aborted) {
			return {
				stdout: "",
				stdoutBytes: new Uint8Array(),
				stderr: "",
				code: null,
				killed: true,
				timedOut: false,
				aborted: true,
			};
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

			const terminate = (reason: "timeout" | "abort"): void => {
				if (settled || killed) {
					return;
				}
				killed = true;
				timedOut = reason === "timeout";
				aborted = reason === "abort";
				signalProcessTree(child, "SIGTERM");
				forceKill = setTimeout(() => {
					void forceTerminateProcessTree(child).then((stopped) => {
						terminationFailed = !stopped;
						terminationFinalized = true;
						finish();
					});
				}, TERMINATION_GRACE_MS);
			};

			const onAbort = (): void => terminate("abort");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeoutMs !== undefined) {
				timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
			}

			const cleanUp = (): void => {
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				if (forceKill) {
					clearTimeout(forceKill);
				}
				untrackProcessGroup(child);
				options.signal?.removeEventListener("abort", onAbort);
			};

			const finish = (): void => {
				if (settled || closeResult === undefined || (killed && !terminationFinalized)) {
					return;
				}
				cleanUp();
				const stdoutBuffer = Buffer.concat(stdout);
				const result: GitRunResult = {
					stdout: stdoutBuffer.toString("utf8"),
					stdoutBytes: new Uint8Array(stdoutBuffer),
					stderr: Buffer.concat(stderr).toString("utf8"),
					code: closeResult.code,
					killed: killed || closeResult.signal !== null,
					timedOut,
					aborted,
				};
				if (terminationFailed) {
					reject(new GitRunError("git_termination_failed", "Git 进程组未能完全终止", result));
					return;
				}
				if (!killed && closeResult.code !== 0) {
					reject(new GitRunError("git_failed", `git 退出码为 ${String(closeResult.code)}`, result));
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

			child.once("close", (code, signal) => {
				if (settled) {
					return;
				}
				closeResult = { code, signal };
				if (!killed) {
					terminationFinalized = true;
				}
				finish();
			});
		});
	}
}

async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
	if (process.platform === "win32" && child.pid !== undefined) {
		await runTaskkill(child.pid, child);
		return true;
	}
	signalProcessTree(child, "SIGKILL");
	if (child.pid === undefined) {
		return true;
	}
	const deadline = Date.now() + PROCESS_TREE_EXIT_TIMEOUT_MS;
	while (processGroupExists(child.pid)) {
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(PROCESS_TREE_POLL_MS);
	}
	return true;
}

function runTaskkill(pid: number, child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		killer.once("error", () => {
			child.kill("SIGKILL");
			finish();
		});
		killer.once("close", finish);
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

export function createGitRunner(): GitRunner {
	return new GitRunner();
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
