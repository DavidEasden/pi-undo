import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach } from "vitest";

import { createPiUndoExtension, type PiUndoRuntime } from "../extensions/pi-undo.ts";
import { createPiUndoRuntime } from "../src/pi-runtime.ts";

/**
 * 真实 pi 0.86.1 SDK + faux provider 测试夹具。
 *
 * 不访问模型网络，也不读取用户配置：模型来自内置 faux provider，资源加载器关闭
 * 全部磁盘发现，settings/session/agent 目录都指向临时目录。测试只通过公开 SDK
 * （createAgentSession / bindExtensions / prompt / navigateTree）驱动 pi-undo，
 * 在真实事件与树导航实现上断言文件与会话状态。
 */

export interface SdkHarness {
	readonly workspace: string;
	readonly session: AgentSession;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly statuses: string[];
	readonly notices: Array<{ readonly text: string; readonly type?: string }>;
	runtime(): PiUndoRuntime;
	dispose(): Promise<void>;
}

export interface TempRoot {
	readonly root: string;
	readonly workspace: string;
	readonly agentDir: string;
	readonly sessionDir: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function createTempRoot(): Promise<TempRoot> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-sdk-"));
	temporaryRoots.push(root);
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	await Promise.all([workspace, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));
	return { root, workspace, agentDir, sessionDir };
}

/** 只提供 pi-undo 会调用的 UI 方法；其余 TUI 方法在离线测试中不参与断言。 */
function createUiContext(record: { statuses: string[]; notices: SdkHarness["notices"] }): ExtensionUIContext {
	const editor = { text: "" };
	return {
		setStatus: (_key: string, text: string | undefined): void => {
			if (text !== undefined) record.statuses.push(text);
		},
		notify: (message: string, type?: "info" | "warning" | "error"): void => {
			record.notices.push({ text: message, ...(type === undefined ? {} : { type }) });
		},
		getEditorText: (): string => editor.text,
		setEditorText: (text: string): void => { editor.text = text; },
	} as unknown as ExtensionUIContext;
}

export async function createHarness(options: {
	readonly workspace: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
}): Promise<SdkHarness> {
	// pi-undo 在 pi-subagents runner 子进程（PI_SUBAGENT_CHILD=1）中保持惰性；本测试
	// 是直接绑定扩展的主会话场景，测试期间临时清除该变量，结束后恢复。
	const subagentChild = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		return await bindHarness(options);
	} finally {
		if (subagentChild !== undefined) process.env.PI_SUBAGENT_CHILD = subagentChild;
	}
}

async function bindHarness(options: {
	readonly workspace: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
}): Promise<SdkHarness> {
	// 固定回复的 faux provider：没有网络请求，也没有模型费用。
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});

	let captured: PiUndoRuntime | undefined;
	const extension = createPiUndoExtension(async (context: ExtensionContext, pi: ExtensionAPI) => {
		captured = await createPiUndoRuntime(context, pi);
		return captured;
	});
	const loader = new DefaultResourceLoader({
		cwd: options.workspace,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		systemPromptOverride: () => "离线回归测试：只按固定指令调用工具。",
		extensionFactories: [extension],
	});
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors;
	if (extensionErrors.length > 0) {
		throw new Error(`扩展加载失败: ${JSON.stringify(extensionErrors)}`);
	}
	const { session } = await createAgentSession({
		cwd: options.workspace,
		agentDir: options.agentDir,
		modelRuntime,
		model: faux.getModel(),
		tools: ["write"],
		sessionManager: options.sessionManager,
		settingsManager,
		resourceLoader: loader,
	});

	const statuses: string[] = [];
	const notices: SdkHarness["notices"] = [];
	await session.bindExtensions({
		mode: "rpc",
		uiContext: createUiContext({ statuses, notices }),
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: (targetId, treeOptions) => session.navigateTree(targetId, treeOptions),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
		onError: (error) => { notices.push({ text: String(error), type: "extension_error" }); },
	});
	if (captured === undefined) throw new Error("pi-undo runtime 未初始化");

	return {
		workspace: options.workspace,
		session,
		faux,
		statuses,
		notices,
		runtime: () => {
			if (captured === undefined) throw new Error("pi-undo runtime 已释放");
			return captured;
		},
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}

export async function createFreshHarness(): Promise<{ temp: TempRoot; harness: SdkHarness }> {
	const temp = await createTempRoot();
	await writeFile(join(temp.workspace, "value.txt"), "before\n");
	const harness = await createHarness({
		workspace: temp.workspace,
		agentDir: temp.agentDir,
		sessionManager: SessionManager.create(temp.workspace, temp.sessionDir),
	});
	return { temp, harness };
}

export function setUpRun(
	faux: ReturnType<typeof fauxProvider>,
	path: string,
	content: string,
	label: string,
): void {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
		fauxAssistantMessage(label),
	]);
}

export function readValue(workspace: string): Promise<string> {
	return readFile(join(workspace, "value.txt"), "utf8");
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待 pi-undo 的后台事务清理收敛到终态，模拟“正常退出后再重启”。
 * 真实进程退出时后台 finalizationQueue 要么完成要么被终止；这里只验证
 * 完成后的干净重启路径，不把同一进程内的并发写当作崩溃恢复场景。
 */
export async function waitForRecoveryDrain(sessionDir: string, timeoutMs = 10_000): Promise<void> {
	const transactionsRoot = join(sessionDir, ".pi-undo", "transactions");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const directories = (await readdir(transactionsRoot, { withFileTypes: true }).catch(() => []))
			.filter((entry) => entry.isDirectory());
		let hasPending = false;
		for (const directory of directories) {
			const raw = await readFile(join(transactionsRoot, directory.name, "state.json"), "utf8").catch(() => undefined);
			if (raw === undefined) continue;
			const phase = (JSON.parse(raw) as { phase?: string }).phase;
			if (phase !== "COMMITTED" && phase !== "ABORTED") {
				hasPending = true;
				break;
			}
		}
		if (!hasPending) return;
		if (Date.now() > deadline) throw new Error("pi-undo 后台事务未在预算内收敛到终态");
		await delay(50);
	}
}

const closedHarnesses = new WeakSet<SdkHarness>();

/** 关闭 harness 前先让后台事务收敛，避免同一进程内的 finalizer 在临时目录删除后报错。 */
export async function closeHarness(harness: SdkHarness, sessionDir: string): Promise<void> {
	if (closedHarnesses.has(harness)) return;
	closedHarnesses.add(harness);
	if (!harness.runtime().controller.history().locked) {
		await waitForRecoveryDrain(sessionDir, 5_000).catch(() => {});
	}
	await harness.dispose();
}

/** 读取会话 JSONL 的 entry，用于校验物理树结构与逻辑叶之间的差异。 */
export async function readSessionEntries(sessionFile: string): Promise<Map<string, Record<string, unknown>>> {
	const lines = (await readFile(sessionFile, "utf8")).split("\n").filter((line) => line.trim().length > 0);
	const entries = new Map<string, Record<string, unknown>>();
	for (const line of lines) {
		const value = JSON.parse(line) as Record<string, unknown>;
		if (value.type === "session" || typeof value.id !== "string") continue;
		entries.set(value.id, value);
	}
	return entries;
}
