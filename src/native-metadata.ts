import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GitRunError, runSupervisedProcess } from "./git-runner.ts";
import { OperationError, type OperationProcessOptions, operationProcessOptions } from "./operation-context.ts";
import { nativeExecutable } from "./native-restore.ts";

const NATIVE_INSPECT_TIMEOUT_MS = 30_000;
const NATIVE_INSPECT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const NATIVE_PROBE_TIMEOUT_MS = 5_000;
const NATIVE_PROBE_OUTPUT_LIMIT = 64 * 1024;
const NATIVE_INSPECT_BATCHES_MAX_BATCHES = 32;
const NATIVE_INSPECT_BATCHES_MAX_PATHS = 16_384;
const NATIVE_INSPECT_BATCHES_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

interface NativeCapabilities {
	readonly inspect: boolean;
	readonly inspectBatches: boolean;
}

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
	inspectBatches?(
		workspaceRoot: string,
		batches: readonly (readonly string[])[],
		requestDirectory: string,
	): Promise<readonly (readonly NativeMetadataEntry[])[] | undefined>;
}

/** 能力探测不支持时回退 TypeScript；已确认支持后的 inspect 错误保持 fail-closed。 */
export class NativeMetadataInspector implements NativeMetadataPort {
	private readonly executable: string | undefined;
	private capability: Promise<NativeCapabilities> | undefined;

	constructor(executable = nativeExecutable()) {
		this.executable = process.env.PI_UNDO_DISABLE_NATIVE === "1" ? undefined : executable;
	}

	async inspect(
		workspaceRoot: string,
		paths: readonly string[],
		requestDirectory: string,
	): Promise<readonly NativeMetadataEntry[] | undefined> {
		if (paths.length === 0) return [];
		// 已取消/超时的操作不启动新的 helper，也不写出请求文件。
		const budget = operationProcessOptions(NATIVE_INSPECT_TIMEOUT_MS);
		const capabilities = await this.nativeCapabilities(requestDirectory);
		if (!capabilities.inspect) return undefined;
		const executable = this.executable!;
		const requestPath = join(requestDirectory, `native-inspect-${process.pid}-${randomUUID()}.json`);
		try {
			await writeFile(requestPath, JSON.stringify({
				schemaVersion: 1,
				workspaceRoot,
				paths,
			}), { mode: 0o600, flag: "wx" });
			return await runNativeInspect(executable, requestPath, paths, budget);
		} finally {
			await rm(requestPath, { force: true }).catch(() => {});
		}
	}


	async inspectBatches(
		workspaceRoot: string,
		batches: readonly (readonly string[])[],
		requestDirectory: string,
	): Promise<readonly (readonly NativeMetadataEntry[])[] | undefined> {
		if (batches.length === 0) return [];
		const totalPaths = batches.reduce((total, batch) => total + batch.length, 0);
		if (
			batches.length > NATIVE_INSPECT_BATCHES_MAX_BATCHES ||
			totalPaths > NATIVE_INSPECT_BATCHES_MAX_PATHS
		) {
			throw new Error("native metadata inspect batches 请求超出限制");
		}
		const requestBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, workspaceRoot, batches }), "utf8");
		if (requestBytes > NATIVE_INSPECT_BATCHES_MAX_REQUEST_BYTES) {
			throw new Error("native metadata inspect batches 请求字节数超出限制");
		}
		const budget = operationProcessOptions(NATIVE_INSPECT_TIMEOUT_MS);
		const capabilities = await this.nativeCapabilities(requestDirectory);
		if (!capabilities.inspectBatches) return undefined;
		const executable = this.executable!;
		const requestPath = join(requestDirectory, `native-inspect-batches-${process.pid}-${randomUUID()}.json`);
		try {
			await writeFile(requestPath, JSON.stringify({ schemaVersion: 1, workspaceRoot, batches }), {
				mode: 0o600,
				flag: "wx",
			});
			return await runNativeInspectBatches(executable, requestPath, batches, budget);
		} finally {
			await rm(requestPath, { force: true }).catch(() => {});
		}
	}
	private nativeCapabilities(requestDirectory: string): Promise<NativeCapabilities> {
		if (this.capability !== undefined) return this.capability;
		this.capability = (async () => {
			if (this.executable === undefined) return { inspect: false, inspectBatches: false };
			try {
				await access(this.executable, constants.X_OK);
				return await probeNativeCapabilities(this.executable, requestDirectory);
			} catch {
				return { inspect: false, inspectBatches: false };
			}
		})();
		return this.capability;
	}
}

async function probeNativeCapabilities(executable: string, isolatedDirectory: string): Promise<NativeCapabilities> {
	try {
		const result = await runSupervisedProcess({
			command: executable,
			args: ["--capabilities"],
			cwd: isolatedDirectory,
			timeoutMs: NATIVE_PROBE_TIMEOUT_MS,
			outputLimitBytes: NATIVE_PROBE_OUTPUT_LIMIT,
			outputOverflow: "terminate",
			diagnosticCommand: "native:metadata-capabilities",
		});
		if (!result.stopped || result.outcome !== "exit" || result.code !== 0) {
			return { inspect: false, inspectBatches: false };
		}
		const value: unknown = JSON.parse(result.stdout.toString("utf8"));
		if (!isRecord(value) || value.ok !== true || !Array.isArray(value.capabilities)) {
			return { inspect: false, inspectBatches: false };
		}
		return {
			inspect: value.capabilities.includes("inspect-v1"),
			inspectBatches: value.capabilities.includes("inspect-batches-v1"),
		};
	} catch {
		return { inspect: false, inspectBatches: false };
	}
}

async function runNativeInspect(
	executable: string,
	requestPath: string,
	expectedPaths: readonly string[],
	budget: OperationProcessOptions,
): Promise<readonly NativeMetadataEntry[]> {
	const result = await runSupervisedProcess({
		command: executable,
		args: ["--inspect", requestPath],
		signal: budget.signal,
		timeoutMs: budget.timeoutMs,
		outputLimitBytes: NATIVE_INSPECT_OUTPUT_LIMIT,
		outputOverflow: "terminate",
		diagnosticCommand: "native:metadata-inspect",
	});
	if (!result.stopped) {
		throw new GitRunError("git_termination_failed", "native metadata inspect 进程未能确认终止");
	}
	if (result.outcome === "cancelled") {
		throw new OperationError("operation_cancelled", "native metadata inspect 已被取消");
	}
	if (result.outcome === "timeout") {
		throw new OperationError("operation_timeout", "native metadata inspect 超时");
	}
	if (result.outcome === "output_overflow") {
		throw new Error("native metadata inspect 输出超过限制");
	}
	if (result.code !== 0) {
		throw new Error(`native metadata inspect 失败：${result.stderr.toString("utf8").trim()}`);
	}
	return parseInspectResponse(result.stdout.toString("utf8"), expectedPaths);
}

async function runNativeInspectBatches(
	executable: string,
	requestPath: string,
	expectedBatches: readonly (readonly string[])[],
	budget: OperationProcessOptions,
): Promise<readonly (readonly NativeMetadataEntry[])[]> {
	const result = await runSupervisedProcess({
		command: executable,
		args: ["--inspect-batches", requestPath],
		signal: budget.signal,
		timeoutMs: budget.timeoutMs,
		outputLimitBytes: NATIVE_INSPECT_OUTPUT_LIMIT,
		outputOverflow: "terminate",
		diagnosticCommand: "native:metadata-inspect-batches",
	});
	if (!result.stopped) {
		throw new GitRunError("git_termination_failed", "native metadata inspect batches 进程未能确认终止");
	}
	if (result.outcome === "cancelled") {
		throw new OperationError("operation_cancelled", "native metadata inspect batches 已被取消");
	}
	if (result.outcome === "timeout") {
		throw new OperationError("operation_timeout", "native metadata inspect batches 超时");
	}
	if (result.outcome === "output_overflow") {
		throw new Error("native metadata inspect batches 输出超过限制");
	}
	if (result.code !== 0) {
		throw new Error(`native metadata inspect batches 失败：${result.stderr.toString("utf8").trim()}`);
	}
	return parseInspectBatchesResponse(result.stdout.toString("utf8"), expectedBatches);
}

function parseInspectResponse(text: string, expectedPaths: readonly string[]): readonly NativeMetadataEntry[] {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.ok !== true || value.processed !== expectedPaths.length || !Array.isArray(value.entries)) {
		throw new Error("native metadata inspect 响应无效");
	}
	return parseInspectEntries(value.entries, expectedPaths);
}

function parseInspectBatchesResponse(
	text: string,
	expectedBatches: readonly (readonly string[])[],
): readonly (readonly NativeMetadataEntry[])[] {
	const value: unknown = JSON.parse(text);
	const expectedTotal = expectedBatches.reduce((total, batch) => total + batch.length, 0);
	if (!isRecord(value) || value.ok !== true || value.processed !== expectedTotal || !Array.isArray(value.batches)) {
		throw new Error("native metadata inspect batches 响应无效");
	}
	if (value.batches.length !== expectedBatches.length) {
		throw new Error("native metadata inspect batches 数量不匹配");
	}
	return value.batches.map((candidate, index) => {
		const expectedPaths = expectedBatches[index]!;
		if (!isRecord(candidate) || candidate.processed !== expectedPaths.length || !Array.isArray(candidate.entries)) {
			throw new Error("native metadata inspect batch 响应无效");
		}
		return parseInspectEntries(candidate.entries, expectedPaths);
	});
}

function parseInspectEntries(
	entries: readonly unknown[],
	expectedPaths: readonly string[],
): readonly NativeMetadataEntry[] {
	if (entries.length !== expectedPaths.length) throw new Error("native metadata inspect 条目数量不匹配");
	return entries.map((candidate, index) => {
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
