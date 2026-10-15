import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { RootDiscovery } from "../src/root-discovery.ts";
import { RestoreEngine } from "../src/restore-engine.ts";
import {
	closeHarness,
	createFreshHarness,
	createHarness,
	delay,
	readSessionEntries,
	readValue,
	setUpRun,
	waitForRecoveryDrain,
} from "./pi-sdk.fixture.ts";

/**
 * 真实 pi 1.2.0 SDK + faux provider 回归（夹具见 pi-sdk.fixture.ts）。
 *
 * 覆盖：普通 undo/redo 与重启重建、第二轮 settled 检查点未完成时的撤销归属、
 * 原生 tree 用户目标（含 pi-undo:start 物理父节点）与带 summary 的导航。
 */

describe("真实 pi 1.2.0 SDK", () => {
	it("摘要失败没有 session_tree 事件时终结 PREPARED，后续 undo 可用", async () => {
		const { temp, harness } = await createFreshHarness();
		try {
			setUpRun(harness.faux, "value.txt", "after\n", "完成");
			await harness.session.prompt("修改文件");
			const checkpoint = harness.runtime().controller.listCheckpoints().at(-1)!;
			const cancellation = vi.spyOn(harness.runtime().controller, "cancelTree");
			harness.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "注入摘要失败" })]);
			await expect(harness.session.navigateTree(checkpoint.userEntryId, { summarize: true })).rejects.toThrow("注入摘要失败");
			await vi.waitFor(() => expect(cancellation).toHaveBeenCalled());
			await cancellation.mock.results[0]!.value;
			await waitForRecoveryDrain(temp.sessionDir);
			expect(await readValue(temp.workspace)).toBe("after\n");
			await harness.session.prompt("/undo");
			expect(await readValue(temp.workspace)).toBe("before\n");
			expect(harness.runtime().controller.history().locked).toBe(false);
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});

	it("后续扩展取消导航时清理准备事务，保留文件和历史", async () => {
		let cancel = true;
		const { temp, harness } = await createFreshHarness([
			(pi) => pi.on("session_before_tree", async () => cancel ? { cancel: true } : undefined),
		]);
		try {
			setUpRun(harness.faux, "value.txt", "after\n", "完成");
			await harness.session.prompt("修改文件");
			const checkpoint = harness.runtime().controller.listCheckpoints().at(-1)!;
			const cancellation = vi.spyOn(harness.runtime().controller, "cancelTree");
			expect((await harness.session.navigateTree(checkpoint.userEntryId, { summarize: false })).cancelled).toBe(true);
			await vi.waitFor(() => expect(cancellation).toHaveBeenCalled());
			await cancellation.mock.results[0]!.value;
			await waitForRecoveryDrain(temp.sessionDir);
			expect(await readValue(temp.workspace)).toBe("after\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
			cancel = false;
			await harness.session.prompt("/undo");
			expect(await readValue(temp.workspace)).toBe("before\n");
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});
	it("普通 undo / redo / 重启后重建历史保持文件与会话一致", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;

		await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
		await session.prompt("把 value.txt 改为 after");
		expect(await readValue(temp.workspace)).toBe("after\n");
		expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });

		await session.prompt("/undo");
		expect(await readValue(temp.workspace)).toBe("before\n");
		expect(harness.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });

		// 重启：以同一个 session JSONL 打开新会话，pi-undo 必须重建出 redo 栈。
		const sessionFile = session.sessionFile;
		const sessionId = session.sessionId;
		expect(sessionFile).toBeDefined();
		await closeHarness(harness, temp.sessionDir);
		const restarted = await createHarness({
			workspace: temp.workspace,
			agentDir: temp.agentDir,
			sessionManager: SessionManager.open(sessionFile!),
		});
		try {
			expect(restarted.session.sessionId).toBe(sessionId);
			expect(await readValue(temp.workspace)).toBe("before\n");
			expect(restarted.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });

			await restarted.session.prompt("/redo");
			expect(await readValue(temp.workspace)).toBe("after\n");
			expect(restarted.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
		} finally {
			await closeHarness(restarted, temp.sessionDir);
		}
	});

	it("第二轮 settled 检查点未完成时 undo 必须等待，完成后回到 after 而不是 before", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;

		await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
		await session.prompt("把 value.txt 改为 after");
		expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });

		// 确定性 gate：卡住第二轮 agentSettled 内部的 durable 预制，稳定复现“Pi 已空闲、
		// 本轮检查点尚未入栈”的窗口。
		const originalPrepare = RestoreEngine.prototype.prepareDurableRestore;
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let markPreparing: () => void = () => {};
		const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
		let gateSignalled = false;
		RestoreEngine.prototype.prepareDurableRestore = async function (
			this: RestoreEngine,
			...args: Parameters<typeof originalPrepare>
		) {
			if (!gateSignalled) {
				gateSignalled = true;
				markPreparing();
			}
			await gate;
			return originalPrepare.apply(this, args);
		};

		let duringGateValue = "";
		let afterGateValue = "";
		try {
			try {
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path: "value.txt", content: "second\n" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("第二轮完成"),
				]);
				const secondRun = session.prompt("把 value.txt 改为 second");
				await preparing;
				// 复现前提：Pi 已经认为自己空闲，但本轮 settled 检查点仍在处理中。
				expect(session.isIdle).toBe(true);

				const undoCommand = session.prompt("/undo");
				await delay(400);
				duringGateValue = await readValue(temp.workspace);

				releaseGate();
				await undoCommand;
				await secondRun;
				afterGateValue = await readValue(temp.workspace);
			} finally {
				releaseGate();
				RestoreEngine.prototype.prepareDurableRestore = originalPrepare;
			}

			expect(duringGateValue, "settled 检查点完成前 undo 不得改动工作区").toBe("second\n");
			expect(afterGateValue, "undo 必须撤回第二轮 settled 检查点，回到 after").toBe("after\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 1, locked: false });
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});

	it("TUI 的正常 settled 快照也不阻塞 prompt 和后续 Esc", async () => {
		const { temp, harness } = await createFreshHarness(undefined, { mode: "tui" });
		const controller = harness.runtime().controller;
		const originalAgentSettled = controller.agentSettled.bind(controller);
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let settledEntered = false;
		const settledSpy = vi.spyOn(controller, "agentSettled").mockImplementation(async () => {
			settledEntered = true;
			await gate;
			await originalAgentSettled();
		});
		try {
			setUpRun(harness.faux, "value.txt", "after\n", "完成");
			let promptReturned = false;
			const prompt = harness.session.prompt("修改文件").finally(() => { promptReturned = true; });
			await vi.waitFor(() => expect(settledEntered).toBe(true));
			await delay(100);
			expect(promptReturned, "TUI prompt 不得等待后台 settled 快照").toBe(true);
			releaseGate();
			await prompt;
			await vi.waitFor(() =>
				expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false }),
			);
		} finally {
			releaseGate();
			settledSpy.mockRestore();
			await closeHarness(harness, temp.sessionDir);
		}
	}, 30_000);

	it("中断的 run 在 settled 快照进行中时 abort 立即返回，检查点随后仍完整入栈", async () => {
		const { temp, harness } = await createFreshHarness(undefined, { tokensPerSecond: 2_000 });
		const { session } = harness;
		const faux = harness.faux;
		try {
			await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
			await session.prompt("把 value.txt 改为 after");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });

			// 用 gate 只拦截中断后的 settled 快照 discover（第 3 次：两次输入前捕获之后）；
			// 前两次分别是两个 run 的输入前捕获，不能拦截。
			const originalDiscover = RootDiscovery.prototype.discover;
			let releaseGate: () => void = () => {};
			const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
			let gatedCalls = 0;
			RootDiscovery.prototype.discover = async function (...args: Parameters<typeof originalDiscover>) {
				gatedCalls += 1;
				if (gatedCalls >= 3) await gate;
				return originalDiscover.apply(this, args);
			};
			try {
				// 慢速流式让 abort 落在 run 中途，而不是等文本瞬间输出完。
				faux.setResponses([fauxAssistantMessage("慢速输出".repeat(2_000))]);
				const runPromise = session.prompt("慢慢输出");
				await vi.waitFor(() => expect(session.isIdle).toBe(false), { timeout: 5_000 });
				await delay(200);

				const abortStarted = performance.now();
				await session.abort();
				const abortMs = performance.now() - abortStarted;
				expect(abortMs, "abort 必须在快照完成前返回").toBeLessThan(1_500);

				releaseGate();
				await runPromise;
				// 中断路径下检查点在后台完成，稍等它入栈后再断言。
				await vi.waitFor(() =>
					expect(harness.runtime().controller.history()).toEqual({ undoCount: 2, redoCount: 0, locked: false }),
					{ timeout: 10_000 });
				await session.prompt("/undo");
				expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 1, locked: false });
			} finally {
				releaseGate();
				RootDiscovery.prototype.discover = originalDiscover;
			}
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	}, 30_000);

	it("原生 tree 导航到用户目标时按逻辑叶恢复工作区（物理父节点是 pi-undo:start）", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;
		try {
			await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
			await session.prompt("把 value.txt 改为 after");
			const checkpoint = harness.runtime().controller.listCheckpoints().at(-1);
			expect(checkpoint).toBeDefined();

			// 关键前提：用户消息的物理父节点是 pi-undo:start 控制条目，而逻辑目标是它之前的叶，
			// 因此不能拿物理 newLeafId 直接与逻辑叶比较。
			const entries = await readSessionEntries(session.sessionFile!);
			const userEntry = entries.get(checkpoint!.userEntryId);
			expect(userEntry).toBeDefined();
			const physicalParent = entries.get(String(userEntry!.parentId));
			expect(physicalParent).toBeDefined();
			expect(physicalParent!.type).toBe("custom");
			expect(physicalParent!.customType).toBe("pi-undo:start");

			const navigation = await session.navigateTree(checkpoint!.userEntryId, { summarize: false });
			expect(navigation.cancelled).toBe(false);
			expect(await readValue(temp.workspace), "回到用户输入前必须同时恢复工作区").toBe("before\n");
			expect(harness.runtime().controller.history().locked).toBe(false);
			expect(harness.runtime().controller.recoveryReason?.()).toBeUndefined();
			const userTexts = session.messages
				.filter((message) => message.role === "user")
				.map((message) => typeof message.content === "string" ? message.content : "");
			expect(userTexts).not.toContain("把 value.txt 改为 after");
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});

	it("tree 导航到用户输入前的根目标时恢复 before，而不是直接取消", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;
		try {
			await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
			await session.prompt("把 value.txt 改为 after");
			const checkpoint = harness.runtime().controller.listCheckpoints().at(-1);
			expect(checkpoint).toBeDefined();

			// 根目标 = pi-undo:start 的物理父节点，即第一个用户输入前的叶。
			// 它可证明地等价于最早 checkpoint 的 before 快照，因此不能一律取消导航。
			const entries = await readSessionEntries(session.sessionFile!);
			const startEntry = entries.get(checkpoint!.startEntryId);
			expect(startEntry).toBeDefined();
			expect(startEntry!.customType).toBe("pi-undo:start");
			const rootTarget = entries.get(String(startEntry!.parentId));
			expect(rootTarget).toBeDefined();
			expect((rootTarget!.message as { role?: string } | undefined)?.role).toBe("system");

			const navigation = await session.navigateTree(String(rootTarget!.id), { summarize: false });
			expect(navigation.cancelled).toBe(false);
			expect(await readValue(temp.workspace), "回到第一个用户输入前必须恢复 before").toBe("before\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 0, locked: false });
			expect(harness.runtime().controller.recoveryReason?.()).toBeUndefined();
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});

	it("tree 带 summary 导航到用户目标时也按逻辑叶恢复工作区", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;
		try {
			await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
			await session.prompt("把 value.txt 改为 after");
			const checkpoint = harness.runtime().controller.listCheckpoints().at(-1);
			expect(checkpoint).toBeDefined();

			// summary 由 faux provider 生成，依旧不访问模型网络。
			faux.setResponses([fauxAssistantMessage("分支摘要")]);
			const navigation = await session.navigateTree(checkpoint!.userEntryId, { summarize: true });
			expect(navigation.cancelled).toBe(false);
			expect(await readValue(temp.workspace), "带 summary 回到用户输入前也必须恢复工作区").toBe("before\n");
			expect(harness.runtime().controller.history().locked).toBe(false);
			expect(harness.runtime().controller.recoveryReason?.()).toBeUndefined();
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});
});
