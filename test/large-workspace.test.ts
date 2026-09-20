import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { RootDiscovery } from "../src/root-discovery.ts";
import { closeHarness, createHarness, createTempRoot, waitForRecoveryDrain } from "./pi-sdk.fixture.ts";

/** 大工作区基准按需运行，常规 CI 通过 performance.test.ts 断言调用次数。 */
describe.skipIf(process.env.PI_UNDO_LARGE_WORKSPACE !== "1")("大型工作区真实 SDK 基准", () => {
	it.each([
		{ packages: 3_000, changedFiles: 1 },
		{ packages: 3_000, changedFiles: 100 },
		{ packages: 10_000, changedFiles: 1 },
		{ packages: 10_000, changedFiles: 100 },
	])("$packages 个依赖包，修改 $changedFiles 个文件", async ({ packages, changedFiles }) => {
		const temp = await createTempRoot();
		await writeFile(join(temp.workspace, ".gitignore"), "node_modules/\n");
		for (let offset = 0; offset < packages; offset += 64) {
			await Promise.all(Array.from({ length: Math.min(64, packages - offset) }, async (_, index) => {
				const directory = join(temp.workspace, "node_modules", `package-${offset + index}`, "lib");
				await mkdir(directory, { recursive: true });
				await writeFile(join(directory, "index.js"), "依赖内容\n");
			}));
		}
		const paths = Array.from({ length: changedFiles }, (_, index) => `value-${index}.txt`);
		await Promise.all(paths.map((path) => writeFile(join(temp.workspace, path), "before\n")));
		const harness = await createHarness({
			workspace: temp.workspace, agentDir: temp.agentDir,
			sessionManager: SessionManager.create(temp.workspace, temp.sessionDir),
		});
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(paths.map((path) => fauxToolCall("write", { path, content: "after\n" })), { stopReason: "toolUse" }),
				fauxAssistantMessage("完成"),
			]);
			await harness.session.prompt("更新测试文件");
			const timings: number[] = [];
			const scans: number[] = [];
			let peakRss = process.memoryUsage().rss;
			const loopDelay = monitorEventLoopDelay({ resolution: 10 });
			loopDelay.enable();
			const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
			try {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const discovery = vi.spyOn(RootDiscovery.prototype, "discover");
					const started = performance.now();
					try {
						await harness.session.prompt("/undo");
						timings.push(Math.round(performance.now() - started));
						scans.push(discovery.mock.calls.length);
					} finally {
						discovery.mockRestore();
					}
					for (const path of paths) expect(await readFile(join(temp.workspace, path), "utf8")).toBe("before\n");
					expect(harness.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
					await waitForRecoveryDrain(temp.sessionDir);
					await harness.session.prompt("/redo");
					await waitForRecoveryDrain(temp.sessionDir);
				}
			} finally {
				clearInterval(sampler);
				loopDelay.disable();
			}
			expect(scans).toEqual([5, 5, 5]);
			const report = JSON.stringify({
				packages, changedFiles, timingsMs: timings, scans,
				medianMs: [...timings].sort((a, b) => a - b)[1],
				peakRssMiB: Math.round(peakRss / 1024 / 1024),
				loopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
			});
			console.log(report);
			if (process.env.PI_UNDO_BENCH_REPORT !== undefined) {
				await appendFile(process.env.PI_UNDO_BENCH_REPORT, `${report}\n`);
			}
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	}, 120_000);
});
