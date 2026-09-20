import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { DurablePack } from "./durable-pack.ts";
import { GitRunError, runSupervisedProcess } from "./git-runner.ts";
import { OperationError, type OperationProcessOptions, operationProcessOptions, rethrowOperationFailure } from "./operation-context.ts";
import type { MutationJournal } from "./mutation-journal.ts";

const NATIVE_TIMEOUT_MS = 120_000;
const NATIVE_OUTPUT_LIMIT = 64 * 1024;

export interface NativeFileBatch {
	readonly available: boolean;
	run(pack: DurablePack): Promise<void>;
	verifySource(pack: DurablePack): Promise<boolean>;
}

export async function createNativeFileBatch(options: {
	readonly workspaceRoot: string;
	readonly planDigest: string;
	readonly journal: MutationJournal;
	/** 测试注入用；默认使用随包分发的平台二进制。 */
	readonly executable?: string;
}): Promise<NativeFileBatch | undefined> {
	if (process.env.PI_UNDO_DISABLE_NATIVE === "1") return undefined;
	const executable = options.executable ?? nativeExecutable();
	if (executable === undefined) return undefined;
	try {
		await access(executable, constants.X_OK);
	} catch {
		return undefined;
	}
	const execute = async (pack: DurablePack, requestPath: string, verifyOnly: boolean): Promise<void> => {
		const paths = pack.paths();
		if (paths.length === 0) return;
		if (pack.planDigest !== options.planDigest) throw new Error("native file batch planDigest 不匹配");
		// 取消/超时检查在写出 request 之前：已取消的操作不产生新工作，也不留下请求文件。
		const budget = operationProcessOptions(NATIVE_TIMEOUT_MS);
		const request = {
			schemaVersion: 1,
			opId: options.journal.operationId,
			packOpId: pack.opId,
			planDigest: pack.planDigest,
			workspaceRoot: options.workspaceRoot,
			packPath: pack.storagePath,
			packChecksum: pack.packChecksum,
			verifyOnly,
			entries: paths.map((path) => {
				const artifacts = pack.artifacts(path);
				const sourceFingerprint = pack.sourceFingerprint(path);
				const targetFingerprint = pack.targetFingerprint(path);
				if (
					artifacts === undefined ||
					sourceFingerprint === undefined ||
					targetFingerprint === undefined
				) {
					throw new Error(`native file batch pack entry 无效：${path}`);
				}
				return {
					path,
					sourceArtifact: artifacts.source,
					targetArtifact: artifacts.target,
					sourceFingerprint,
					targetFingerprint,
				};
			}),
		};
		await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
		await runNative(executable, requestPath, paths.length, budget);
	};
	return {
		available: true,
		run: (pack) => execute(pack, join(dirname(options.journal.storagePath), "native-request-v1.json"), false),
		verifySource: async (pack) => {
			try {
				await execute(pack, join(dirname(pack.storagePath), `native-verify-${process.pid}.json`), true);
				return true;
			} catch (error) {
				rethrowOperationFailure(error);
				return false;
			}
		},
	};
}

export function nativeExecutable(): string | undefined {
	const platform = process.platform === "darwin"
		? "darwin"
		: process.platform === "linux" ? "linux"
		: process.platform === "win32" ? "win32" : undefined;
	const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
	if (platform === undefined || architecture === undefined) return undefined;
	const extension = process.platform === "win32" ? ".exe" : "";
	return fileURLToPath(new URL(`../native/bin/pi-undo-fs-${platform}-${architecture}${extension}`, import.meta.url));
}

async function runNative(
	executable: string,
	requestPath: string,
	expected: number,
	budget: OperationProcessOptions,
): Promise<void> {
	const result = await runSupervisedProcess({
		command: executable,
		args: [requestPath],
		signal: budget.signal,
		timeoutMs: budget.timeoutMs,
		outputLimitBytes: NATIVE_OUTPUT_LIMIT,
	});
	if (!result.stopped) {
		// 无法证明 helper 已停止：保留 lease，让上层走恢复流程。
		throw new GitRunError("git_termination_failed", "native restore 进程未能确认终止");
	}
	if (result.outcome === "cancelled") {
		throw new OperationError("operation_cancelled", "native restore 已被取消");
	}
	if (result.outcome === "timeout") {
		throw new OperationError("operation_timeout", "native restore 超时");
	}
	if (result.outcome === "output_overflow") {
		throw new Error("native restore 输出超过限制");
	}
	if (result.code !== 0) {
		throw new Error(`native restore 失败：${result.stderr.toString("utf8").trim()}`);
	}
	const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("ok" in parsed) ||
		parsed.ok !== true ||
		!("processed" in parsed) ||
		parsed.processed !== expected
	) {
		throw new Error("native restore 响应无效");
	}
}
