import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitRunError, runSupervisedProcess } from "./git-runner.ts";
import { probeNativeCapability } from "./native-capabilities.ts";
import { nativeExecutable } from "./native-restore.ts";
import { checkOperation, configuredTimeout, OperationError, operationProcessOptions } from "./operation-context.ts";

export interface NativeRepositoryCandidate {
	readonly path: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

export interface NativeDirectoryScan {
	readonly directories: number;
	readonly repositories: readonly NativeRepositoryCandidate[];
}

export interface NativeDirectoryScanPort {
	scan(workspaceRoot: string): Promise<NativeDirectoryScan | undefined>;
}

/** 只缓存 helper 能力；每个拓扑检查点均重新完整扫描工作区，包括 ignored 目录。 */
export class NativeDirectoryScanner implements NativeDirectoryScanPort {
	private readonly executable: string | undefined;
	private capability: Promise<boolean> | undefined;

	constructor(executable = nativeExecutable()) {
		this.executable = process.env.PI_UNDO_DISABLE_NATIVE === "1" || process.platform === "win32"
			? undefined : executable;
	}

	async scan(workspaceRoot: string): Promise<NativeDirectoryScan | undefined> {
		checkOperation();
		if (this.executable === undefined || (this.capability !== undefined && !await this.capability)) return undefined;
		const requestDirectory = await mkdtemp(join(tmpdir(), "pi-undo-native-scan-"));
		try {
			this.capability ??= this.supportsScan(requestDirectory).catch((error) => {
				// 取消或未确认终止不能污染后续操作的能力缓存。
				this.capability = undefined;
				throw error;
			});
			if (!await this.capability) return undefined;
			const budget = operationProcessOptions(configuredTimeout("PI_UNDO_OPERATION_TIMEOUT_MS", 300_000));
			const requestPath = join(requestDirectory, "request.json");
			await writeFile(requestPath, JSON.stringify({ schemaVersion: 1, workspaceRoot }), { mode: 0o600, flag: "wx" });
			const result = await runSupervisedProcess({
				command: this.executable,
				args: ["--scan-directories", requestPath],
				...budget,
				outputLimitBytes: 32 * 1024 * 1024,
				outputOverflow: "terminate",
			});
			if (!result.stopped) throw new GitRunError("git_termination_failed", "native 目录扫描进程未能确认终止");
			if (result.outcome === "cancelled") {
				checkOperation();
				throw new OperationError("operation_cancelled", "native 目录扫描已被取消");
			}
			if (result.outcome === "timeout") throw new OperationError("operation_timeout", "native 目录扫描超时");
			if (result.outcome !== "exit" || result.code !== 0) {
				throw new Error(`native 目录扫描失败：${result.stderr.toString("utf8").trim() || result.outcome}`);
			}
			checkOperation();
			return parseScanResponse(result.stdout.toString("utf8"));
		} finally {
			await rm(requestDirectory, { recursive: true, force: true }).catch(() => {});
		}
	}

	private async supportsScan(directory: string): Promise<boolean> {
		try {
			await access(this.executable!, constants.X_OK);
		} catch {
			return false;
		}
		return probeNativeCapability(this.executable!, "scan-directories-v1", directory);
	}
}

function parseScanResponse(text: string): NativeDirectoryScan | undefined {
	const value: unknown = JSON.parse(text);
	// 深度上限是执行器的资源边界；此时丢弃部分结果，由 TypeScript 从根完整重扫。
	if (isRecord(value) && value.ok === false && value.code === "depth_limit") return undefined;
	if (!isRecord(value) || value.ok !== true || !Number.isSafeInteger(value.directories) ||
		(value.directories as number) < 1 || !Array.isArray(value.repositories) ||
		value.repositories.length >= (value.directories as number)) {
		throw new Error("native 目录扫描响应无效");
	}
	const seen = new Set<string>();
	const repositories = value.repositories.map((candidate): NativeRepositoryCandidate => {
		if (!isRecord(candidate) || typeof candidate.path !== "string" || candidate.path.includes("\0") ||
			candidate.path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
			seen.has(candidate.path)) {
			throw new Error("native 仓库候选路径无效");
		}
		seen.add(candidate.path);
		return { path: candidate.path, dev: parseIdentity(candidate.dev), ino: parseIdentity(candidate.ino) };
	});
	return { directories: value.directories as number, repositories };
}

function parseIdentity(value: unknown): bigint {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) {
		throw new Error("native 目录身份字段无效");
	}
	return BigInt(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
