import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type MemorySnapshot = {
	workerRssMiB: number;
	runnerTreeRssMiB: number;
	nonWorkerRssMiB: number;
	nativeHelperRssMiB: number;
	heapUsedMiB: number;
	externalMiB: number;
	arrayBuffersMiB: number;
};

type MemoryMode = "baseline" | "extension";
const childMode = process.env.PI_UNDO_MEMORY_CHILD as MemoryMode | undefined;
const isChildRun = childMode === "baseline" || childMode === "extension";
const MiB = 1024 * 1024;

function processTreeRssBytes(): { workerRssBytes: number; treeRssBytes: number; nativeHelperRssBytes: number } {
	const workerRssBytes = process.memoryUsage().rss;
	try {
		const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
		});
		const processes = new Map<number, { ppid: number; rssBytes: number; command: string }>();
		const children = new Map<number, number[]>();
		for (const row of rows.trim().split("\n")) {
			const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
			if (match === null) continue;
			const pid = Number(match[1]);
			const ppid = Number(match[2]);
			const rssBytes = Number(match[3]) * 1024;
			processes.set(pid, { ppid, rssBytes, command: match[4]! });
			const siblings = children.get(ppid) ?? [];
			siblings.push(pid);
			children.set(ppid, siblings);
		}
		const directParent = processes.get(process.ppid);
		const runnerPid = /vitest(?:\.mjs|\/)/i.test(directParent?.command ?? "") ? process.ppid : process.pid;
		let treeRssBytes = 0;
		let nativeHelperRssBytes = 0;
		const pending = [runnerPid];
		while (pending.length > 0) {
			const pid = pending.pop()!;
			const entry = processes.get(pid);
			if (entry === undefined) continue;
			treeRssBytes += entry.rssBytes;
			if (/pi-undo-fs(?:-|\s)/.test(entry.command)) nativeHelperRssBytes += entry.rssBytes;
			pending.push(...(children.get(pid) ?? []));
		}
		return { workerRssBytes, treeRssBytes, nativeHelperRssBytes };
	} catch {
		return { workerRssBytes, treeRssBytes: workerRssBytes, nativeHelperRssBytes: 0 };
	}
}

function sampleMemory(): MemorySnapshot {
	const usage = process.memoryUsage();
	const rss = processTreeRssBytes();
	return {
		workerRssMiB: roundMiB(rss.workerRssBytes),
		runnerTreeRssMiB: roundMiB(rss.treeRssBytes),
		nonWorkerRssMiB: roundMiB(Math.max(0, rss.treeRssBytes - rss.workerRssBytes)),
		nativeHelperRssMiB: roundMiB(rss.nativeHelperRssBytes),
		heapUsedMiB: roundMiB(usage.heapUsed),
		externalMiB: roundMiB(usage.external),
		arrayBuffersMiB: roundMiB(usage.arrayBuffers),
	};
}

function roundMiB(bytes: number): number {
	return Math.round(bytes / MiB * 10) / 10;
}

async function createLargeWorkspace(workspace: string): Promise<void> {
	await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
	await writeFile(join(workspace, "value.txt"), "before\n");
	for (let offset = 0; offset < 10_000; offset += 64) {
		await Promise.all(Array.from({ length: Math.min(64, 10_000 - offset) }, async (_, index) => {
			const directory = join(workspace, "node_modules", `package-${offset + index}`, "lib");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "index.js"), "dependency\n");
		}));
	}
}

async function waitForManifest(sessionDir: string, delay: (ms: number) => Promise<void>): Promise<void> {
	const manifests = join(sessionDir, ".pi-undo", "stores");
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		for (const store of await readdir(manifests, { withFileTypes: true }).catch(() => [])) {
			if (!store.isDirectory()) continue;
			const files = await readdir(join(manifests, store.name, "manifests")).catch(() => []);
			if (files.some((name) => name.endsWith(".json"))) return;
		}
		await delay(100);
	}
	throw new Error("pi-undo warm-up manifest 未在预算内生成");
}

async function waitForDurablePacks(sessionDir: string, expected: number, delay: (ms: number) => Promise<void>): Promise<void> {
	const indexPath = join(sessionDir, ".pi-undo", "durable-cache", "index.json");
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const index = JSON.parse(await readFile(indexPath, "utf8")) as { entries?: unknown[] };
			if ((index.entries?.length ?? 0) >= expected) return;
		} catch {
			// 后台 pack 预制尚未发布索引。
		}
		await delay(100);
	}
	throw new Error("undo/redo durable pack 未在预算内预制完成");
}

async function runMemoryChild(mode: MemoryMode): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-memory-"));
	const temp = {
		root,
		workspace: join(root, "workspace"),
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
	};
	await Promise.all([temp.workspace, temp.agentDir, temp.sessionDir]
		.map((directory) => mkdir(directory, { recursive: true })));
	let phase = "workspace";
	const peaks: Record<string, MemorySnapshot> = {};
	const retained: Record<string, MemorySnapshot> = {};
	const recordPeak = (): void => {
		const value = sampleMemory();
		const previous = peaks[phase];
		if (previous === undefined) peaks[phase] = value;
		else {
			for (const key of Object.keys(value) as Array<keyof MemorySnapshot>) {
				previous[key] = Math.max(previous[key], value[key]);
			}
		}
	};
	const recordRetained = (): MemorySnapshot => {
		const value = sampleMemory();
		retained[phase] = value;
		return value;
	};
	const sampler = setInterval(recordPeak, 200);
	let session: { prompt(text: string): Promise<unknown>; dispose(): void } | undefined;
	let extensionHarness: Awaited<ReturnType<(typeof import("./pi-sdk.fixture.ts"))["createHarness"]>> | undefined;
	let cleanupExtension: (() => Promise<void>) | undefined;
	let startedAt = 0;
	try {
		await createLargeWorkspace(temp.workspace);
		global.gc?.();
		recordPeak();
		recordRetained();
		phase = "sdk-init";
		startedAt = performance.now();
		const sdk = await import("@earendil-works/pi-coding-agent");
		const sessionManager = sdk.SessionManager.create(temp.workspace, temp.sessionDir);
		if (mode === "baseline") {
			const [ai, { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager }] = await Promise.all([
				import("@earendil-works/pi-ai"), import("@earendil-works/pi-coding-agent"),
			]);
			const provider = ai.fauxProvider({ tokensPerSecond: 1_000_000 });
			const modelRuntime = await ModelRuntime.create({
				credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
				allowModelNetwork: false, refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(provider.provider);
			await modelRuntime.setRuntimeApiKey(provider.provider.id, "faux-key");
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
			});
			const loader = new DefaultResourceLoader({
				cwd: temp.workspace, agentDir: temp.agentDir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "memory baseline",
			});
			await loader.reload();
			const result = await createAgentSession({
				cwd: temp.workspace, agentDir: temp.agentDir, modelRuntime,
				model: provider.getModel(), tools: ["write"], sessionManager, settingsManager, resourceLoader: loader,
			});
			session = result.session;
		} else {
			const fixture = await import("./pi-sdk.fixture.ts");
			const harness = await fixture.createHarness({
				workspace: temp.workspace,
				agentDir: temp.agentDir,
				sessionManager,
			});
			session = harness.session;
			extensionHarness = harness;
			cleanupExtension = async () => fixture.closeHarness(harness, temp.sessionDir);
		}
		recordPeak();
		recordRetained();
		if (mode === "baseline") {
			phase = "idle";
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		} else {
			const [fixture, ai] = await Promise.all([import("./pi-sdk.fixture.ts"), import("@earendil-works/pi-ai")]);
			phase = "warm-up";
			await waitForManifest(temp.sessionDir, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
			await new Promise((resolve) => setTimeout(resolve, 500));
			global.gc?.();
			const warmupMemory = recordRetained();
			if (
				process.platform === "darwin" && process.env.PI_UNDO_DISABLE_NATIVE !== "1" &&
				warmupMemory.nativeHelperRssMiB <= 0
			) {
				throw new Error("memory benchmark 未检测到 native helper 进程，不能验证进程树 RSS");
			}
			recordPeak();

			phase = "run";
			const harness = extensionHarness!;
			harness.faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall("write", { path: "value.txt", content: "after\n" }), { stopReason: "toolUse" }),
				ai.fauxAssistantMessage("done"),
			]);
			await session.prompt("update the test file");
			await waitForDurablePacks(temp.sessionDir, 2, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
			await fixture.waitForRecoveryDrain(temp.sessionDir);

			phase = "undo";
			await session.prompt("/undo");
			phase = "redo";
			await session.prompt("/redo");
			phase = "idle-after-operations";
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		global.gc?.();
		recordRetained();
		recordPeak();
		console.log(`PI_UNDO_MEMORY_RESULT=${JSON.stringify({
			mode,
			workspacePackages: 10_000,
			setupMs: Math.round(performance.now() - startedAt),
			gcAvailable: typeof global.gc === "function",
			phases: peaks,
			retained,
		})}`);
	} finally {
		clearInterval(sampler);
		if (cleanupExtension !== undefined) await cleanupExtension();
		else session?.dispose();
		await rm(temp.root, { recursive: true, force: true });
	}
}

async function runChildProcess(mode: MemoryMode): Promise<string> {
	const child = spawn(process.execPath, [
		"--expose-gc",
		"node_modules/vitest/vitest.mjs",
		"run",
		"test/resident-memory-benchmark.test.ts",
		"--pool=forks",
		"--maxWorkers=1",
		"--reporter=verbose",
		"-t",
		"memory child",
	], {
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_OPTIONS: [process.env.NODE_OPTIONS, "--expose-gc"].filter(Boolean).join(" "),
			PI_UNDO_MEMORY_CHILD: mode,
			PI_UNDO_MEMORY_BENCHMARK: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (child.pid === undefined) throw new Error(`无法启动 ${mode} memory child`);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
	const exitCode = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${mode} memory child 超时`));
		}, 180_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code ?? 1);
		});
	});
	if (exitCode !== 0) throw new Error(`${mode} memory child 失败 (${exitCode})\n${stderr}\n${stdout}`);
	const result = stdout.split("\n").find((line) => line.startsWith("PI_UNDO_MEMORY_RESULT="));
	if (result === undefined) throw new Error(`${mode} memory child 未输出结果\n${stderr}\n${stdout}`);
	return result.slice("PI_UNDO_MEMORY_RESULT=".length);
}

describe.skipIf(!isChildRun)("resident memory child", () => {
	it(`memory child ${childMode}`, async () => {
		await runMemoryChild(childMode!);
	});
});

describe.skipIf(process.env.PI_UNDO_MEMORY_BENCHMARK !== "1" || isChildRun)("resident memory benchmark", () => {
	it("Pi SDK 基线与 pi-undo 10k workspace 内存对比", async () => {
		const baseline = JSON.parse(await runChildProcess("baseline")) as Record<string, unknown>;
		const extension = JSON.parse(await runChildProcess("extension")) as Record<string, unknown>;
		console.log(JSON.stringify({ benchmark: "resident-memory", baseline, extension }));
		expect(baseline.mode).toBe("baseline");
		expect(extension.mode).toBe("extension");
	});
});
