import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { DurablePack } from "./durable-pack.ts";
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
}): Promise<NativeFileBatch | undefined> {
	if (process.env.PI_UNDO_DISABLE_NATIVE === "1") return undefined;
	const executable = nativeExecutable();
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
		await runNative(executable, requestPath, paths.length);
	};
	return {
		available: true,
		run: (pack) => execute(pack, join(dirname(options.journal.storagePath), "native-request-v1.json"), false),
		verifySource: async (pack) => {
			try {
				await execute(pack, join(dirname(pack.storagePath), `native-verify-${process.pid}.json`), true);
				return true;
			} catch {
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

function runNative(executable: string, requestPath: string, expected: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, [requestPath], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		const timeout = setTimeout(() => child.kill("SIGKILL"), NATIVE_TIMEOUT_MS);
		const capture = (target: Buffer[]) => (chunk: Buffer | string): void => {
			if (outputBytes >= NATIVE_OUTPUT_LIMIT) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const captured = bytes.subarray(0, NATIVE_OUTPUT_LIMIT - outputBytes);
			target.push(captured);
			outputBytes += captured.length;
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
			if (code !== 0) {
				reject(new Error(`native restore 失败：${Buffer.concat(stderr).toString("utf8").trim()}`));
				return;
			}
			try {
				const result: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
				if (
					typeof result !== "object" ||
					result === null ||
					!("ok" in result) ||
					result.ok !== true ||
					!("processed" in result) ||
					result.processed !== expected
				) {
					throw new Error("native restore 响应无效");
				}
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}
