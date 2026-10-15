import { constants, rmSync } from "node:fs";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { GitRunError, runSupervisedProcess } from "./git-runner.ts";
import { probeNativeCapabilities } from "./native-capabilities.ts";
import { nativeExecutable } from "./native-restore.ts";
import { checkOperation, configuredTimeout, OperationError, operationProcessOptions } from "./operation-context.ts";
import { ResidentScanClient } from "./resident-scan-client.ts";

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
	/** 可选的会话级预热；测试替身和旧调用方无需实现。 */
	prewarm?(workspaceRoot: string): void;
	/** 运行时销毁时关闭常驻 helper，避免跨会话遗留进程。 */
	dispose?(): Promise<void>;
}

const nativeScanCacheDirectories = new Set<string>();
let nativeScanCacheCleanupRegistered = false;

function registerNativeScanCacheDirectory(directory: string): void {
	nativeScanCacheDirectories.add(directory);
	if (nativeScanCacheCleanupRegistered) return;
	nativeScanCacheCleanupRegistered = true;
	process.once("exit", () => {
		for (const path of nativeScanCacheDirectories) {
			try { rmSync(path, { recursive: true, force: true }); } catch { /* 退出阶段尽力清理 */ }
		}
	});
}

function isPathInside(root: string, candidate: string): boolean {
	const child = relative(resolve(root), resolve(candidate));
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** 原生 helper 能力之外，目录快照只在逐目录元数据仍可证明时复用。 */
export class NativeDirectoryScanner implements NativeDirectoryScanPort {
	private readonly executable: string | undefined;
	private capabilities: Promise<ReadonlySet<string>> | undefined;
	private cacheDirectory: Promise<string> | undefined;
	private resident: { readonly workspaceRoot: string; readonly client: ResidentScanClient } | undefined;
	private prewarmInFlight: { readonly workspaceRoot: string; readonly promise: Promise<void> } | undefined;

	constructor(executable = nativeExecutable()) {
		this.executable = process.env.PI_UNDO_DISABLE_NATIVE === "1" || process.platform === "win32"
			? undefined : executable;
	}

	/**
	 * 会话初始化时只预热常驻扫描，不触发一次性 helper。
	 * 正式 discover 会等待这次预热完成，然后请求同一个 serve 缓存，保证变化仍被事件失效检查覆盖。
	 */
	prewarm(workspaceRoot: string): void {
		if (this.executable === undefined || this.prewarmInFlight?.workspaceRoot === workspaceRoot) return;
		const promise = this.prewarmResident(workspaceRoot).catch(() => undefined).finally(() => {
			if (this.prewarmInFlight?.promise === promise) this.prewarmInFlight = undefined;
		});
		this.prewarmInFlight = { workspaceRoot, promise };
	}

	/** 运行时销毁时关闭常驻 helper。 */
	async dispose(): Promise<void> {
		await this.prewarmInFlight?.promise;
		await this.resident?.client.close();
		this.resident = undefined;
	}

	private async prewarmResident(workspaceRoot: string): Promise<void> {
		const temporaryRoot = await realpath(tmpdir()).catch(() => undefined);
		if (temporaryRoot === undefined || isPathInside(workspaceRoot, temporaryRoot)) return;
		const requestDirectory = await mkdtemp(join(temporaryRoot, "pi-undo-native-serve-probe-"));
		try {
			const capabilities = await this.probeCapabilities(requestDirectory);
			if (!capabilities.has("scan-serve-v1")) return;
			const client = this.ensureResident(workspaceRoot);
			if (client !== undefined) await client.prewarm();
		} finally {
			await rm(requestDirectory, { recursive: true, force: true }).catch(() => {});
		}
	}

	private ensureResident(workspaceRoot: string): ResidentScanClient | undefined {
		if (this.executable === undefined) return undefined;
		if (this.resident?.workspaceRoot === workspaceRoot) return this.resident.client;
		if (this.resident !== undefined) void this.resident.client.close();
		const client = new ResidentScanClient(
			this.executable,
			workspaceRoot,
			configuredTimeout("PI_UNDO_OPERATION_TIMEOUT_MS", 300_000),
		);
		this.resident = { workspaceRoot, client };
		return client;
	}

	async scan(workspaceRoot: string): Promise<NativeDirectoryScan | undefined> {
		checkOperation();
		if (this.executable === undefined) return undefined;
		const pendingPrewarm = this.prewarmInFlight;
		if (pendingPrewarm?.workspaceRoot === workspaceRoot) await pendingPrewarm.promise;
		checkOperation();
		// TMPDIR 可能通过符号链接指向工作区；先核验真实路径，再创建任何请求或缓存。
		const temporaryRoot = await realpath(tmpdir()).catch(() => undefined);
		if (temporaryRoot === undefined || isPathInside(workspaceRoot, temporaryRoot)) return undefined;
		const requestDirectory = await mkdtemp(join(temporaryRoot, "pi-undo-native-scan-"));
		try {
			const capabilities = await this.probeCapabilities(requestDirectory);
			const version = capabilities.has("scan-directories-v2") ? "v2"
				: capabilities.has("scan-directories-v1") ? "v1" : undefined;
			if (version === undefined) return undefined;

			if (capabilities.has("scan-serve-v1")) {
				const client = this.ensureResident(workspaceRoot);
				if (client !== undefined) {
					const response = await client.scan();
					checkOperation();
					if (response !== undefined) {
						const parsed = parseResidentResponse(response);
						if (parsed !== undefined) return parsed;
						client.reset();
					}
				}
				// serve 失败或协议无效：继续使用一次性 helper。
			}

			const budget = operationProcessOptions(configuredTimeout("PI_UNDO_OPERATION_TIMEOUT_MS", 300_000));
			const requestPath = join(requestDirectory, "request.json");
			const cachePath = version === "v2"
				? await this.directoryCachePath(workspaceRoot, temporaryRoot, requestDirectory) : undefined;
			await writeFile(requestPath, JSON.stringify({
				schemaVersion: version === "v2" ? 2 : 1,
				workspaceRoot,
				...(cachePath === undefined ? {} : { cachePath }),
			}), { mode: 0o600, flag: "wx" });
			const result = await runSupervisedProcess({
				command: this.executable,
				args: ["--scan-directories", requestPath],
				...budget,
				outputLimitBytes: 32 * 1024 * 1024,
				outputOverflow: "terminate",
				diagnosticCommand: "native:scan-directories",
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

	private async probeCapabilities(directory: string): Promise<ReadonlySet<string>> {
		try {
			await access(this.executable!, constants.X_OK);
		} catch {
			return new Set<string>();
		}
		if (this.capabilities === undefined) {
			const probe = probeNativeCapabilities(this.executable!, directory).catch((error) => {
				// 取消或未确认退出不能污染后续操作的能力缓存；普通的不支持结果由
				// probeNativeCapabilities 返回空集合并可安全缓存。
				this.capabilities = undefined;
				throw error;
			});
			this.capabilities = probe;
		}
		return await this.capabilities;
	}

	private async directoryCachePath(
		workspaceRoot: string,
		temporaryRoot: string,
		requestDirectory: string,
	): Promise<string> {
		try {
			if (this.cacheDirectory === undefined) {
				this.cacheDirectory = mkdtemp(join(temporaryRoot, "pi-undo-native-scan-cache-")).catch((error) => {
					this.cacheDirectory = undefined;
					throw error;
				});
			}
			const directory = await this.cacheDirectory;
			if (isPathInside(workspaceRoot, directory)) {
				// 工作区切换后不再把该目录当成本实例可以删除的私有缓存。
				nativeScanCacheDirectories.delete(directory);
				this.cacheDirectory = undefined;
				return join(requestDirectory, "directories.json");
			}
			registerNativeScanCacheDirectory(directory);
			return join(directory, "directories.json");
		} catch {
			this.cacheDirectory = undefined;
			return join(requestDirectory, "directories.json");
		}
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

function parseResidentResponse(value: Record<string, unknown>): NativeDirectoryScan | undefined {
	try {
		return parseScanValue(value);
	} catch {
		return undefined;
	}
}

function parseScanValue(value: unknown): NativeDirectoryScan | undefined {
	if (!isRecord(value) || value.ok !== true || !Number.isSafeInteger(value.directories) ||
		(value.directories as number) < 1 || !Array.isArray(value.repositories) ||
		value.repositories.length >= (value.directories as number)) {
		throw new Error("native 目录扫描响应无效");
	}
	const seen = new Set<string>();
	const repositories: NativeRepositoryCandidate[] = [];
	for (const candidate of value.repositories) {
		if (!isRecord(candidate) || typeof candidate.path !== "string" || candidate.path.includes("\0") ||
			candidate.path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
			seen.has(candidate.path)) {
			throw new Error("native 仓库候选路径无效");
		}
		seen.add(candidate.path);
		repositories.push({ path: candidate.path, dev: parseIdentity(candidate.dev), ino: parseIdentity(candidate.ino) });
	}
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
