import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_OWNER_FILE = "owner.json";
const OWNER_PREFIX = "owner.";
const OWNER_SUFFIX = ".json";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const inProcessQueues = new Map<string, Promise<void>>();

interface LockOwner {
	readonly pid: number;
	readonly processStartedAt: number;
	readonly workspaceIdentity: string;
	readonly nonce: string;
	readonly leaseExpiresAt: number;
}

interface ValidOwnerState {
	readonly kind: "valid";
	readonly fileName: string;
	readonly owner: LockOwner;
}

type OwnerState =
	| ValidOwnerState
	| { readonly kind: "missing" }
	| { readonly kind: "invalid" };

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

	constructor(code: WorkspaceLockErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
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
		return enqueue(workspaceIdentity, async () => {
			const lease = await this.acquire(workspaceIdentity);
			try {
				return await fn();
			} finally {
				await lease.release();
			}
		});
	}

	private async acquire(workspaceIdentity: string): Promise<{ release(): Promise<void> }> {
		await mkdir(this.lockRoot, { recursive: true });
		const lockDirectory = workspaceLockPath(this.lockRoot, workspaceIdentity);
		const deadline = this.clock() + this.acquireTimeoutMs;

		while (true) {
			const owner: LockOwner = {
				pid: process.pid,
				processStartedAt: currentProcessStartedAt(this.clock()),
				workspaceIdentity,
				nonce: randomBytes(16).toString("hex"),
				leaseExpiresAt: this.clock() + this.leaseMs,
			};
			const candidateDirectory = `${lockDirectory}.candidate.${process.pid}.${owner.nonce}`;
			const ownerFile = ownerFileName(owner.nonce);
			let published = false;
			try {
				await mkdir(candidateDirectory);
				await writeOwnerInitial(candidateDirectory, ownerFile, owner);
				await rename(candidateDirectory, lockDirectory);
				published = true;
			} catch (error) {
				if (!await pathExists(lockDirectory)) {
					throw error;
				}
			} finally {
				if (!published) {
					await rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
				}
			}

			if (published) {
				return this.startLease(lockDirectory, ownerFile, owner);
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

	private startLease(
		lockDirectory: string,
		ownerFile: string,
		owner: LockOwner,
	): { release(): Promise<void> } {
		let renewal = Promise.resolve();
		let compromised: WorkspaceLockError | undefined;
		const heartbeat = setInterval(() => {
			renewal = renewal.then(async () => {
				if (compromised !== undefined) {
					return;
				}
				try {
					await this.renew(lockDirectory, ownerFile, owner);
				} catch (error) {
					compromised = asCompromised(error);
				}
			});
		}, Math.max(10, Math.floor(this.leaseMs / 3)));
		heartbeat.unref();

		return {
			release: async () => {
				clearInterval(heartbeat);
				await renewal;
				if (compromised !== undefined) {
					throw compromised;
				}
				await releaseOwner(lockDirectory, ownerFile, owner.nonce);
			},
		};
	}

	private async renew(lockDirectory: string, ownerFile: string, owner: LockOwner): Promise<void> {
		const current = await readOwnerState(lockDirectory);
		if (!sameOwner(current, ownerFile, owner.nonce)) {
			throw new WorkspaceLockError("lock_compromised", "workspace lock owner 已变化");
		}
		const temporaryFile = `.renew.${owner.nonce}.${randomBytes(8).toString("hex")}`;
		const temporaryPath = join(lockDirectory, temporaryFile);
		try {
			await writeFile(
				temporaryPath,
				serializeOwner({ ...owner, leaseExpiresAt: this.clock() + this.leaseMs }),
				{ flag: "wx", mode: 0o600 },
			);
			const verified = await readOwnerState(lockDirectory, new Set([temporaryFile]));
			if (!sameOwner(verified, ownerFile, owner.nonce)) {
				throw new WorkspaceLockError("lock_compromised", "workspace lock owner 续租校验失败");
			}
			await rename(temporaryPath, join(lockDirectory, ownerFile));
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => {});
		}
	}

	private async reclaimStaleLease(lockDirectory: string, workspaceIdentity: string): Promise<boolean> {
		const state = await readOwnerState(lockDirectory);
		if (state.kind === "invalid") {
			return false;
		}
		if (state.kind === "missing") {
			const metadata = await stat(lockDirectory).catch(() => null);
			if (metadata === null) {
				return true;
			}
			if (this.clock() - metadata.mtimeMs <= this.leaseMs) {
				return false;
			}
			return removeEmptyDirectory(lockDirectory);
		}
		if (
			state.owner.workspaceIdentity !== workspaceIdentity ||
			state.owner.leaseExpiresAt > this.clock() ||
			!ownerProcessIsConfirmedDead(state.owner)
		) {
			return false;
		}

		const verified = await readOwnerState(lockDirectory);
		if (!sameOwner(verified, state.fileName, state.owner.nonce)) {
			return false;
		}
		try {
			await unlink(join(lockDirectory, state.fileName));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return false;
			}
			throw error;
		}
		return removeEmptyDirectory(lockDirectory);
	}
}

export function workspaceLockPath(lockRoot: string, workspaceIdentity: string): string {
	const digest = createHash("sha256").update(workspaceIdentity).digest("hex");
	return join(lockRoot, `${digest}.lock`);
}

async function enqueue<T>(workspaceIdentity: string, fn: () => Promise<T>): Promise<T> {
	const previous = inProcessQueues.get(workspaceIdentity) ?? Promise.resolve();
	let resolveCurrent: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		resolveCurrent = resolve;
	});
	inProcessQueues.set(workspaceIdentity, current);
	await previous;
	try {
		return await fn();
	} finally {
		resolveCurrent?.();
		if (inProcessQueues.get(workspaceIdentity) === current) {
			inProcessQueues.delete(workspaceIdentity);
		}
	}
}

async function readOwnerState(lockDirectory: string, ignoredFiles = new Set<string>()): Promise<OwnerState> {
	let entries;
	try {
		entries = await readdir(lockDirectory, { withFileTypes: true });
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { kind: "missing" };
		}
		return { kind: "invalid" };
	}
	const visible = entries.filter((entry) => !ignoredFiles.has(entry.name));
	if (visible.length === 0) {
		return { kind: "missing" };
	}
	if (visible.length !== 1 || !visible[0].isFile() || !isOwnerFileName(visible[0].name)) {
		return { kind: "invalid" };
	}
	const fileName = visible[0].name;
	try {
		const value: unknown = JSON.parse(await readFile(join(lockDirectory, fileName), "utf8"));
		if (!isLockOwner(value) || (fileName !== LEGACY_OWNER_FILE && fileName !== ownerFileName(value.nonce))) {
			return { kind: "invalid" };
		}
		return { kind: "valid", fileName, owner: value };
	} catch {
		return { kind: "invalid" };
	}
}

async function writeOwnerInitial(lockDirectory: string, fileName: string, owner: LockOwner): Promise<void> {
	await writeFile(join(lockDirectory, fileName), serializeOwner(owner), { flag: "wx", mode: 0o600 });
}

async function releaseOwner(lockDirectory: string, ownerFile: string, nonce: string): Promise<void> {
	const current = await readOwnerState(lockDirectory);
	if (!sameOwner(current, ownerFile, nonce)) {
		throw new WorkspaceLockError("lock_compromised", "workspace lock release 时 owner 已变化");
	}
	await unlink(join(lockDirectory, ownerFile));
	if (!await removeEmptyDirectory(lockDirectory)) {
		const replacement = await readOwnerState(lockDirectory);
		if (replacement.kind === "valid" && replacement.owner.nonce !== nonce) {
			return;
		}
		throw new WorkspaceLockError("lock_compromised", "workspace lock release 时目录已被复用");
	}
}

async function removeEmptyDirectory(directory: string): Promise<boolean> {
	try {
		await rmdir(directory);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return true;
		}
		if (hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EEXIST")) {
			return false;
		}
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

function sameOwner(state: OwnerState, fileName: string, nonce: string): state is ValidOwnerState {
	return state.kind === "valid" && state.fileName === fileName && state.owner.nonce === nonce;
}

function isOwnerFileName(fileName: string): boolean {
	return fileName === LEGACY_OWNER_FILE || (
		fileName.startsWith(OWNER_PREFIX) &&
		fileName.endsWith(OWNER_SUFFIX) &&
		/^[0-9a-f]{32}$/.test(fileName.slice(OWNER_PREFIX.length, -OWNER_SUFFIX.length))
	);
}

function ownerFileName(nonce: string): string {
	return `${OWNER_PREFIX}${nonce}${OWNER_SUFFIX}`;
}

function serializeOwner(owner: LockOwner): string {
	return `${JSON.stringify(owner)}\n`;
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
		Number.isFinite(record.processStartedAt) &&
		typeof record.workspaceIdentity === "string" &&
		record.workspaceIdentity.length > 0 &&
		typeof record.nonce === "string" &&
		record.nonce.length > 0 &&
		typeof record.leaseExpiresAt === "number" &&
		Number.isFinite(record.leaseExpiresAt)
	);
}

function currentProcessStartedAt(now: number): number {
	return Math.floor(now - process.uptime() * 1_000);
}

function ownerProcessIsConfirmedDead(owner: LockOwner): boolean {
	if (owner.pid <= 0 || !Number.isFinite(owner.processStartedAt)) {
		return false;
	}
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return hasErrorCode(error, "ESRCH");
	}
}

function asCompromised(error: unknown): WorkspaceLockError {
	return error instanceof WorkspaceLockError
		? error
		: new WorkspaceLockError("lock_compromised", "workspace lock 续租失败", { cause: error });
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
