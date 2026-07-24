import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER_FILE = "owner.json";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

interface LockOwner {
	readonly pid: number;
	readonly processStartedAt: number;
	readonly workspaceIdentity: string;
	readonly nonce: string;
	readonly leaseExpiresAt: number;
}

export interface WorkspaceLockOptions {
	readonly lockRoot?: string;
	readonly leaseMs?: number;
	readonly retryMs?: number;
	readonly acquireTimeoutMs?: number;
	readonly clock?: () => number;
}

export type WorkspaceLockErrorCode = "lock_timeout" | "lock_compromised";

export class WorkspaceLockError extends Error {
	readonly code: WorkspaceLockErrorCode;

	constructor(code: WorkspaceLockErrorCode, message: string) {
		super(message);
		this.name = "WorkspaceLockError";
		this.code = code;
	}
}

export interface WorkspaceLock {
	withLock<T>(workspaceIdentity: string, fn: () => Promise<T>): Promise<T>;
}

export class WorkspaceLock {
	private readonly lockRoot: string;
	private readonly leaseMs: number;
	private readonly retryMs: number;
	private readonly acquireTimeoutMs: number;
	private readonly clock: () => number;
	private readonly inProcessQueues = new Map<string, Promise<void>>();

	constructor(options: WorkspaceLockOptions = {}) {
		this.lockRoot = options.lockRoot ?? join(tmpdir(), "pi-undo-workspace-locks");
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
		this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
		this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
		this.clock = options.clock ?? Date.now;
		assertPositive(this.leaseMs, "leaseMs");
		assertPositive(this.retryMs, "retryMs");
		assertPositive(this.acquireTimeoutMs, "acquireTimeoutMs");
	}

	async withLock<T>(workspaceIdentity: string, fn: () => Promise<T>): Promise<T> {
		if (workspaceIdentity.length === 0) {
			throw new WorkspaceLockError("lock_compromised", "workspace identity 不能为空");
		}
		return this.enqueue(workspaceIdentity, async () => {
			const lease = await this.acquire(workspaceIdentity);
			try {
				return await fn();
			} finally {
				await lease.release();
			}
		});
	}

	private async enqueue<T>(workspaceIdentity: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.inProcessQueues.get(workspaceIdentity) ?? Promise.resolve();
		let resolveCurrent: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			resolveCurrent = resolve;
		});
		this.inProcessQueues.set(workspaceIdentity, current);
		await previous;
		try {
			return await fn();
		} finally {
			resolveCurrent?.();
			if (this.inProcessQueues.get(workspaceIdentity) === current) {
				this.inProcessQueues.delete(workspaceIdentity);
			}
		}
	}

	private async acquire(workspaceIdentity: string): Promise<{ release(): Promise<void> }> {
		await mkdir(this.lockRoot, { recursive: true });
		const lockDirectory = workspaceLockPath(this.lockRoot, workspaceIdentity);
		const deadline = this.clock() + this.acquireTimeoutMs;

		while (true) {
			try {
				await mkdir(lockDirectory);
				break;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) {
					throw error;
				}
				if (await this.reclaimStaleLease(lockDirectory, workspaceIdentity)) {
					continue;
				}
				if (this.clock() >= deadline) {
					throw new WorkspaceLockError("lock_timeout", "workspace lock 获取超时");
				}
				await delay(this.retryMs);
			}
		}

		const owner: LockOwner = {
			pid: process.pid,
			processStartedAt: currentProcessStartedAt(this.clock()),
			workspaceIdentity,
			nonce: randomBytes(16).toString("hex"),
			leaseExpiresAt: this.clock() + this.leaseMs,
		};
		try {
			await writeOwner(lockDirectory, owner);
		} catch (error) {
			await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}

		const heartbeat = setInterval(() => {
			void this.renew(lockDirectory, owner).catch(() => {});
		}, Math.max(10, Math.floor(this.leaseMs / 3)));
		heartbeat.unref();

		return {
			release: async () => {
				clearInterval(heartbeat);
				const current = await readOwner(lockDirectory);
				if (current?.nonce === owner.nonce) {
					await rm(lockDirectory, { recursive: true, force: true });
				}
			},
		};
	}

	private async renew(lockDirectory: string, owner: LockOwner): Promise<void> {
		const current = await readOwner(lockDirectory);
		if (current?.nonce !== owner.nonce) {
			return;
		}
		await writeOwner(lockDirectory, { ...owner, leaseExpiresAt: this.clock() + this.leaseMs });
	}

	private async reclaimStaleLease(lockDirectory: string, workspaceIdentity: string): Promise<boolean> {
		const owner = await readOwner(lockDirectory);
		if (owner === null) {
			const metadata = await stat(lockDirectory).catch(() => null);
			if (metadata === null || this.clock() - metadata.mtimeMs <= this.leaseMs) {
				return false;
			}
			if (await readOwner(lockDirectory) !== null) {
				return false;
			}
			await rm(lockDirectory, { recursive: true, force: true });
			return true;
		}
		if (
			owner.workspaceIdentity !== workspaceIdentity ||
			owner.leaseExpiresAt > this.clock() ||
			processExists(owner.pid)
		) {
			return false;
		}

		const verified = await readOwner(lockDirectory);
		if (verified?.nonce !== owner.nonce) {
			return false;
		}
		await rm(lockDirectory, { recursive: true, force: true });
		return true;
	}
}

export function workspaceLockPath(lockRoot: string, workspaceIdentity: string): string {
	const digest = createHash("sha256").update(workspaceIdentity).digest("hex");
	return join(lockRoot, `${digest}.lock`);
}

async function readOwner(lockDirectory: string): Promise<LockOwner | null> {
	try {
		const value: unknown = JSON.parse(await readFile(join(lockDirectory, OWNER_FILE), "utf8"));
		return isLockOwner(value) ? value : null;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return null;
		}
		return null;
	}
}

async function writeOwner(lockDirectory: string, owner: LockOwner): Promise<void> {
	await writeFile(join(lockDirectory, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function isLockOwner(value: unknown): value is LockOwner {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		Number.isInteger(record.pid) &&
		typeof record.processStartedAt === "number" &&
		typeof record.workspaceIdentity === "string" &&
		typeof record.nonce === "string" &&
		typeof record.leaseExpiresAt === "number"
	);
}

function currentProcessStartedAt(now: number): number {
	return Math.floor(now - process.uptime() * 1_000);
}

function processExists(pid: number): boolean {
	if (pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertPositive(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} 必须是正数`);
	}
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
