import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { nativeExecutable } from "./native-restore.ts";

const NATIVE_INSPECT_TIMEOUT_MS = 30_000;
const NATIVE_INSPECT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export interface NativeMetadataEntry {
	readonly path: string;
	readonly kind: "absent" | "file" | "symlink" | "other";
	readonly dev?: bigint;
	readonly ino?: bigint;
	readonly mode?: bigint;
	readonly size?: bigint;
	readonly mtimeNs?: bigint;
	readonly ctimeNs?: bigint;
}

export interface NativeMetadataPort {
	inspect(
		workspaceRoot: string,
		paths: readonly string[],
		requestDirectory: string,
	): Promise<readonly NativeMetadataEntry[] | undefined>;
}

/** 能力探测不支持时回退 TypeScript；已确认支持后的 inspect 错误保持 fail-closed。 */
export class NativeMetadataInspector implements NativeMetadataPort {
	private readonly executable: string | undefined;
	private capability: Promise<boolean> | undefined;

	constructor(executable = nativeExecutable()) {
		this.executable = process.env.PI_UNDO_DISABLE_NATIVE === "1" ? undefined : executable;
	}

	async inspect(
		workspaceRoot: string,
		paths: readonly string[],
		requestDirectory: string,
	): Promise<readonly NativeMetadataEntry[] | undefined> {
		if (paths.length === 0) return [];
		if (!await this.supportsInspect(requestDirectory)) return undefined;
		const executable = this.executable!;
		const requestPath = join(requestDirectory, `native-inspect-${process.pid}-${randomUUID()}.json`);
		try {
			await writeFile(requestPath, JSON.stringify({
				schemaVersion: 1,
				workspaceRoot,
				paths,
			}), { mode: 0o600, flag: "wx" });
			return await runNativeInspect(executable, requestPath, paths);
		} finally {
			await rm(requestPath, { force: true }).catch(() => {});
		}
	}

	private supportsInspect(requestDirectory: string): Promise<boolean> {
		if (this.capability !== undefined) return this.capability;
		this.capability = (async () => {
			if (this.executable === undefined) return false;
			try {
				await access(this.executable, constants.X_OK);
				return await probeNativeInspect(this.executable, requestDirectory);
			} catch {
				return false;
			}
		})();
		return this.capability;
	}
}

function probeNativeInspect(executable: string, isolatedDirectory: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(executable, ["--capabilities"], {
			cwd: isolatedDirectory,
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += value.length;
			if (bytes <= 64 * 1024) stdout.push(value);
			else child.kill("SIGKILL");
		});
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(false);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code !== 0 || bytes > 64 * 1024) return resolve(false);
			try {
				const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
				resolve(isRecord(value) && value.ok === true && Array.isArray(value.capabilities) &&
					value.capabilities.includes("inspect-v1"));
			} catch {
				resolve(false);
			}
		});
	});
}

function runNativeInspect(
	executable: string,
	requestPath: string,
	expectedPaths: readonly string[],
): Promise<readonly NativeMetadataEntry[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["--inspect", requestPath], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let overflow = false;
		const timeout = setTimeout(() => child.kill("SIGKILL"), NATIVE_INSPECT_TIMEOUT_MS);
		const capture = (target: Buffer[]) => (chunk: Buffer | string): void => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (outputBytes + bytes.length > NATIVE_INSPECT_OUTPUT_LIMIT) {
				overflow = true;
				child.kill("SIGKILL");
				return;
			}
			target.push(bytes);
			outputBytes += bytes.length;
		};
		child.stdout?.on("data", capture(stdout));
		child.stderr?.on("data", capture(stderr));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (overflow) {
				reject(new Error("native metadata inspect 输出超过限制"));
				return;
			}
			if (code !== 0) {
				reject(new Error(`native metadata inspect 失败：${Buffer.concat(stderr).toString("utf8").trim()}`));
				return;
			}
			try {
				resolve(parseInspectResponse(Buffer.concat(stdout).toString("utf8"), expectedPaths));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function parseInspectResponse(text: string, expectedPaths: readonly string[]): readonly NativeMetadataEntry[] {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.ok !== true || value.processed !== expectedPaths.length || !Array.isArray(value.entries)) {
		throw new Error("native metadata inspect 响应无效");
	}
	if (value.entries.length !== expectedPaths.length) throw new Error("native metadata inspect 条目数量不匹配");
	return value.entries.map((candidate, index) => {
		if (!isRecord(candidate) || candidate.path !== expectedPaths[index] ||
			!isMetadataKind(candidate.kind)) {
			throw new Error("native metadata inspect 条目无效");
		}
		if (candidate.kind === "absent") {
			if ([candidate.dev, candidate.ino, candidate.mode, candidate.size, candidate.mtimeNs, candidate.ctimeNs]
				.some((field) => field !== null && field !== undefined)) {
				throw new Error("native metadata absent 条目包含 metadata");
			}
			return { path: candidate.path as string, kind: "absent" as const };
		}
		return {
			path: candidate.path as string,
			kind: candidate.kind,
			dev: parseUnsigned(candidate.dev, 64),
			ino: parseUnsigned(candidate.ino, 64),
			mode: parseUnsigned(candidate.mode, 32),
			size: parseUnsigned(candidate.size, 64),
			mtimeNs: parseTimestamp(candidate.mtimeNs),
			ctimeNs: parseTimestamp(candidate.ctimeNs),
		};
	});
}

function parseUnsigned(value: unknown, bits: 32 | 64): bigint {
	const maxDigits = bits === 32 ? 10 : 20;
	if (typeof value !== "string" || value.length > maxDigits || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error("native metadata unsigned 字段无效");
	}
	const parsed = BigInt(value);
	if (parsed > (1n << BigInt(bits)) - 1n) throw new Error("native metadata unsigned 字段越界");
	return parsed;
}

function parseTimestamp(value: unknown): bigint {
	if (typeof value !== "string" || value.length > 30 || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error("native metadata timestamp 字段无效");
	}
	const parsed = BigInt(value);
	const billion = 1_000_000_000n;
	const minimum = -(1n << 63n) * billion;
	const maximum = ((1n << 63n) - 1n) * billion + (billion - 1n);
	if (parsed < minimum || parsed > maximum) throw new Error("native metadata timestamp 字段越界");
	return parsed;
}

function isMetadataKind(value: unknown): value is NativeMetadataEntry["kind"] {
	return value === "absent" || value === "file" || value === "symlink" || value === "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
