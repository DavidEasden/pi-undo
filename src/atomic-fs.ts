import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson } from "./encoding.ts";

export type AtomicFileErrorCode = "content_mismatch" | "invalid_mode";

export class AtomicFileError extends Error {
	readonly code: AtomicFileErrorCode;

	constructor(code: AtomicFileErrorCode, message: string) {
		super(message);
		this.name = "AtomicFileError";
		this.code = code;
	}
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await writeBytesAtomic(file, Buffer.from(canonicalJson(value), "utf8"));
}

export async function writeBytesAtomic(file: string, bytes: Uint8Array, mode?: number): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true });
	const fileMode = await targetMode(file, mode);
	const temporary = await writeTemporary(directory, basename(file), bytes, fileMode);
	let published = false;

	try {
		await rename(temporary, file);
		published = true;
		await fsyncDirectory(directory);
	} finally {
		if (!published) {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}
}

export async function writeContentAddressed(file: string, bytes: Uint8Array, mode?: number): Promise<void> {
	const expected = Buffer.from(bytes);
	try {
		const existing = await readFile(file);
		if (!existing.equals(expected)) {
			throw new AtomicFileError("content_mismatch", "内容寻址文件已存在但内容不同");
		}
		return;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
	}

	const directory = dirname(file);
	await mkdir(directory, { recursive: true });
	const temporary = await writeTemporary(directory, basename(file), expected, await targetMode(file, mode));
	let linked = false;
	try {
		await link(temporary, file);
		linked = true;
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) {
			throw error;
		}
		const published = await readFile(file);
		if (!published.equals(expected)) {
			throw new AtomicFileError("content_mismatch", "内容寻址文件已存在但内容不同");
		}
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}

	if (linked) {
		await fsyncDirectory(directory);
	}
}

export async function fsyncFile(file: string): Promise<void> {
	const handle = await open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** 不支持目录 fsync 的平台/文件系统（Windows/NTFS、网络盘、exFAT、FUSE 等）返回的 errno。 */
const TOLERATED_DIR_FSYNC_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** 目录 fsync 失败是否因平台/文件系统不支持而可以安全降级跳过。 */
export function isToleratedDirFsyncError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error &&
		typeof (error as { code?: unknown }).code === "string" &&
		TOLERATED_DIR_FSYNC_CODES.has((error as { code: string }).code);
}

export async function fsyncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") {
		// Windows 对目录句柄调用 fsync 必然返回 EPERM；rename 的持久性由文件系统自身保证。
		return;
	}
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} catch (error) {
		// 目录 fsync 只是崩溃持久性的 best-effort 强化，文件内容的 fsync 不受影响：
		// 不支持目录 fsync 的文件系统降级跳过，其余错误照常传播。
		if (!isToleratedDirFsyncError(error)) throw error;
	} finally {
		await handle.close();
	}
}

export async function writeBytesExclusive(
	file: string,
	bytes: Uint8Array,
	mode: number,
	options: { readonly syncDirectory?: boolean; readonly syncFile?: boolean } = {},
): Promise<void> {
	const handle = await open(file, "wx", mode);
	try {
		await handle.writeFile(Buffer.from(bytes));
		await handle.chmod(mode);
		if (options.syncFile !== false) await handle.sync();
	} finally {
		await handle.close();
	}
	if (options.syncDirectory !== false) await fsyncDirectory(dirname(file));
}

async function targetMode(file: string, mode: number | undefined): Promise<number> {
	if (mode !== undefined) {
		if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
			throw new AtomicFileError("invalid_mode", "文件 mode 无效");
		}
		return mode;
	}

	try {
		return (await stat(file)).mode & 0o7777;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return 0o600;
		}
		throw error;
	}
}

async function writeTemporary(
	directory: string,
	fileName: string,
	bytes: Uint8Array,
	mode: number,
): Promise<string> {
	const temporary = join(
		directory,
		`.${fileName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, "wx", mode);
		await handle.writeFile(Buffer.from(bytes));
		await handle.chmod(mode);
		await handle.sync();
		await handle.close();
		handle = undefined;
		return temporary;
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
