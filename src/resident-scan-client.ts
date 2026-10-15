import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { currentOperationContext } from "./operation-context.ts";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

type LineWaiter = {
	readonly child: ChildProcessWithoutNullStreams;
	readonly resolve: (line: string | undefined) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
};

/**
 * 一个 workspace 对应一个 `--serve` 子进程。
 *
 * stdout 持续保留行缓冲，因为握手响应和首次扫描响应可能在同一个 data
 * chunk 中到达。请求按顺序排队；取消、超时、协议错误或子进程退出都会
 * 丢弃整个进程，调用方随后回退一次性扫描。
 */
export class ResidentScanClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private starting: Promise<ChildProcessWithoutNullStreams | undefined> | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private buffer = "";
	private waiter: LineWaiter | undefined;
	private closed = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly executable: string,
		private readonly workspaceRoot: string,
		private readonly timeoutMs: number,
	) {}

	/** 建立进程并完成首次全量扫描；失败静默，正式扫描会回退。 */
	prewarm(): Promise<void> {
		return this.scan(5_000).then(() => undefined, () => undefined);
	}

	scan(timeoutMs = this.timeoutMs): Promise<JsonObject | undefined> {
		const result = this.queue.then(
			() => this.scanOne(timeoutMs),
			() => this.scanOne(timeoutMs),
		);
		const settled = result.finally(() => this.scheduleIdle());
		this.queue = settled.then(() => undefined, () => undefined);
		return settled;
	}

	private async scanOne(timeoutMs: number): Promise<JsonObject | undefined> {
		if (this.closed) return undefined;
		const child = await this.ensureChild(timeoutMs);
		if (child === undefined) return undefined;
		const line = await this.requestLine(child, JSON.stringify({ schemaVersion: 1 }), timeoutMs);
		if (line === undefined) return undefined;
		try {
			return parseObject(line);
		} catch {
			this.invalidate(child);
			return undefined;
		}
	}

	private async ensureChild(timeoutMs: number): Promise<ChildProcessWithoutNullStreams | undefined> {
		if (this.child !== undefined && this.child.exitCode === null) return this.child;
		this.starting ??= this.spawnChild(timeoutMs).finally(() => { this.starting = undefined; });
		return await this.starting;
	}

	private async spawnChild(timeoutMs: number): Promise<ChildProcessWithoutNullStreams | undefined> {
		if (this.closed) return undefined;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(this.executable, ["--serve"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			return undefined;
		}
		this.child = child;
		this.buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string | Buffer) => this.receive(child, chunk.toString()));
		child.stderr.resume();
		child.once("error", () => this.childExited(child));
		child.once("exit", () => this.childExited(child));
		try {
			const handshakeLine = await this.requestLine(child, JSON.stringify({
				schemaVersion: 1,
				workspaceRoot: this.workspaceRoot,
			}), timeoutMs);
			const handshake = handshakeLine === undefined ? undefined : parseObjectOrUndefined(handshakeLine);
			if (handshake?.ok !== true || handshake.ready !== true) {
				this.invalidate(child);
				return undefined;
			}
			// Rust helper 会在 ready 后发送首次全量扫描响应；必须消费，避免
			// 下一次请求把这条旧响应误认为自己的结果。
			const initialLine = await this.readLine(child, timeoutMs);
			const initial = initialLine === undefined ? undefined : parseObjectOrUndefined(initialLine);
			if (initial?.ok !== true) {
				this.invalidate(child);
				return undefined;
			}
			return child;
		} catch {
			this.invalidate(child);
			return undefined;
		}
	}

	private requestLine(child: ChildProcessWithoutNullStreams, request: string, timeoutMs: number): Promise<string | undefined> {
		if (this.child !== child || child.exitCode !== null) return Promise.resolve(undefined);
		try {
			child.stdin.write(`${request}\n`);
		} catch {
			this.invalidate(child);
			return Promise.resolve(undefined);
		}
		return this.readLine(child, timeoutMs);
	}

	private readLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string | undefined> {
		const buffered = this.takeLine();
		if (buffered !== undefined) return Promise.resolve(buffered);
		if (this.waiter !== undefined) return Promise.resolve(undefined);
		const context = currentOperationContext();
		const remaining = context === undefined
			? timeoutMs
			: Math.min(timeoutMs, Math.max(1, context.deadline - Date.now()));
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.invalidate(child);
				resolve(undefined);
			}, remaining);
			const onAbort = context === undefined ? undefined : (): void => {
				this.invalidate(child);
				resolve(undefined);
			};
			this.waiter = {
				child,
				resolve,
				timer,
				...(context === undefined ? {} : { signal: context.signal }),
				...(onAbort === undefined ? {} : { onAbort }),
			};
			if (context?.signal.aborted === true) onAbort?.();
			else if (onAbort !== undefined) context?.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
		if (this.child !== child) return;
		this.buffer += chunk;
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_RESPONSE_BYTES) {
			const waiter = this.waiter;
			this.invalidate(child);
			waiter?.resolve(undefined);
			return;
		}
		const waiter = this.waiter;
		if (waiter === undefined) return;
		const line = this.takeLine();
		if (line === undefined) return;
		this.detachWaiter(child);
		waiter.resolve(line);
	}

	private takeLine(): string | undefined {
		const newline = this.buffer.indexOf("\n");
		if (newline < 0) return undefined;
		const line = this.buffer.slice(0, newline);
		this.buffer = this.buffer.slice(newline + 1);
		return line.endsWith("\r") ? line.slice(0, -1) : line;
	}

	private detachWaiter(child: ChildProcessWithoutNullStreams): LineWaiter | undefined {
		const waiter = this.waiter;
		if (waiter === undefined || waiter.child !== child) return undefined;
		clearTimeout(waiter.timer);
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		this.waiter = undefined;
		return waiter;
	}

	private childExited(child: ChildProcessWithoutNullStreams): void {
		if (this.child !== child) return;
		const waiter = this.detachWaiter(child);
		this.child = undefined;
		this.buffer = "";
		waiter?.resolve(undefined);
	}

	private invalidate(child: ChildProcessWithoutNullStreams): void {
		const waiter = this.detachWaiter(child);
		if (this.child === child) {
			this.child = undefined;
			this.buffer = "";
		}
		if (child.exitCode === null) child.kill("SIGKILL");
		waiter?.resolve(undefined);
	}

	private scheduleIdle(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		if (this.closed) return;
		this.idleTimer = setTimeout(() => {
			void this.close();
		}, 70_000);
		this.idleTimer.unref?.();
	}

	/** 丢弃当前进程但保留客户端，使下一次请求可以重新握手。 */
	reset(): void {
		this.closed = false;
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		const child = this.child;
		if (child !== undefined) this.invalidate(child);
		this.buffer = "";
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		const child = this.child;
		if (child !== undefined) this.invalidate(child);
		await this.queue;
		this.child?.kill("SIGKILL");
		this.child = undefined;
	}
}

function parseObjectOrUndefined(line: string): JsonObject | undefined {
	try {
		return parseObject(line);
	} catch {
		return undefined;
	}
}

function parseObject(line: string): JsonObject {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("serve 响应不是对象");
	}
	return value as JsonObject;
}
