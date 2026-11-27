import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { JournalStore } from "../src/journal.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
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

	it.each([
		{ label: "合并相位写入前", writeBeforeFailure: false, phase: "APPLYING" },
		{ label: "合并相位写入后", writeBeforeFailure: true, phase: "CURSOR_COMMITTED" },
	])("cursor 已持久化但$label失败，重启后补完并可 redo", async ({ writeBeforeFailure, phase }) => {
		const { temp, harness } = await createFreshHarness();
		const original = JournalStore.prototype.setPhases;
		const injected = vi.spyOn(JournalStore.prototype, "setPhases").mockImplementation(async function (this: JournalStore, opId, transitions) {
			if (transitions.some((transition) => transition.phase === "FILES_VERIFIED")) {
				if (writeBeforeFailure) await original.call(this, opId, transitions);
				throw new Error("注入 cursor 后相位提交失败");
			}
			await original.call(this, opId, transitions);
		});
		let restarted: Awaited<ReturnType<typeof createHarness>> | undefined;
		try {
			setUpRun(harness.faux, "value.txt", "after\n", "完成");
			await harness.session.prompt("修改文件");
			await harness.session.prompt("/undo");
			expect(await readValue(temp.workspace)).toBe("before\n");
			expect(harness.runtime().controller.history().locked).toBe(true);
			const journals = await new JournalStore({
				transactionsRoot: join(temp.sessionDir, ".pi-undo", "transactions"),
			}).loadPending();
			expect(journals).toHaveLength(1);
			expect(journals[0]?.state.phase).toBe(phase);
			const sessionFile = harness.session.sessionFile!;
			injected.mockRestore();
			await closeHarness(harness, temp.sessionDir);
			restarted = await createHarness({
				workspace: temp.workspace,
				agentDir: temp.agentDir,
				sessionManager: SessionManager.open(sessionFile),
			});
			expect(await readValue(temp.workspace)).toBe("before\n");
			expect(restarted.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
			await waitForRecoveryDrain(temp.sessionDir);
			await restarted.session.prompt("/redo");
			expect(await readValue(temp.workspace)).toBe("after\n");
			expect(restarted.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
		} finally {
			injected.mockRestore();
			await closeHarness(harness, temp.sessionDir);
			if (restarted !== undefined) await closeHarness(restarted, temp.sessionDir);
		}
	});

	it("第二轮 settled 检查点未完成时 undo 必须等待，完成后回到 after 而不是 before", async () => {
		const { temp, harness } = await createFreshHarness();
		const { session } = harness;
		const faux = harness.faux;

		await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
		await session.prompt("把 value.txt 改为 after");
		expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });

		// 用 RootDiscovery.prototype.discover gate 卡住第二轮 settled 的 capture 关键路径，
		// 稳定复现"Pi 已空闲、本轮检查点尚未入栈"的窗口。
		const originalDiscover = RootDiscovery.prototype.discover;
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let markPreparing: () => void = () => {};
		const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
		RootDiscovery.prototype.discover = async function (...args: Parameters<typeof originalDiscover>) {
			// settled capture 入口用专属 reason "settled-capture"，与输入前 capture 区分。
			if (args[1] === "settled-capture") {
				markPreparing();
				await gate;
			}
			return originalDiscover.apply(this, args);
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
				RootDiscovery.prototype.discover = originalDiscover;
			}

			expect(duringGateValue, "settled 检查点完成前 undo 不得改动工作区").toBe("second\n");
			expect(afterGateValue, "undo 必须撤回第二轮 settled 检查点，回到 after").toBe("after\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 1, locked: false });
		} finally {
			await closeHarness(harness, temp.sessionDir);
		}
	});

	it.each(["tui", "rpc"] as const)("输入快照挂起时 Esc 中断不等待扫描完成（%s）", async (mode) => {
		const { temp, harness } = await createFreshHarness(undefined, { mode });
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const original = RootDiscovery.prototype.discover;
		const scan = vi.spyOn(RootDiscovery.prototype, "discover").mockImplementation(async function (this: RootDiscovery, ...args) {
			entered();
			await gate;
			return original.apply(this, args);
		});
		let run: Promise<void> | undefined;
		let abort: Promise<void> | undefined;
		try {
			harness.faux.setResponses([fauxAssistantMessage("不应在取消后开始输出")]);
			run = harness.session.prompt("取消输入快照");
			await ready;
			await vi.waitFor(() => expect(harness.session.agent.signal).toBeDefined());
			abort = harness.session.abort();
			const stopped = await Promise.race([abort.then(() => true), delay(500).then(() => false)]);
			expect(stopped, "快照仍被 gate 阻塞时，Pi 必须响应 Esc 并结束 run").toBe(true);
			expect(harness.faux.state.callCount).toBe(0);
			await run;
			expect(harness.session.isIdle).toBe(true);
			expect(harness.runtime().controller.captureFailed()).toBe(false);
			release();
			await harness.runtime().controller.agentSettled();

			// 取消后的旧扫描退出时，不得影响下一轮真实工具调用及其撤销记录。
			setUpRun(harness.faux, "value.txt", "after\n", "取消后的下一轮完成");
			await harness.session.prompt("取消后修改文件");
			await vi.waitFor(() => expect(harness.runtime().controller.history()).toEqual({
				undoCount: 1, redoCount: 0, locked: false,
			}));
			expect(await readValue(temp.workspace)).toBe("after\n");
			await harness.session.prompt("/undo");
			expect(await readValue(temp.workspace)).toBe("before\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
			expect(harness.notices.filter(({ type }) => type === "extension_error")).toEqual([]);
		} finally {
			release();
			await Promise.allSettled([run, abort]);
			scan.mockRestore();
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

	it("中断后立即 /undo 会等待检查点并继续恢复文件，而不是停在旧内容", async () => {
		// 场景：第一轮正常完成，第二轮运行期间用户按了 Esc 中断。
		// Pi 返回空闲后用户立即输入 /undo。
		// 预期：/undo 应等待第二轮检查点完成再恢复（回到 after），
		// 而不是撤回第一轮（回到 before）。
		const { temp, harness } = await createFreshHarness(undefined, { tokensPerSecond: 2_000 });
		const { session } = harness;
		const faux = harness.faux;
		try {
			await setUpRun(faux, "value.txt", "after\n", "第一轮完成");
			await session.prompt("把 value.txt 改为 after");
			expect(await readValue(temp.workspace)).toBe("after\n");
			expect(harness.runtime().controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });

			// gate 卡住第二轮 settled 的 topology discovery，使检查点尚未入栈时可立即触发 undo。
			const originalDiscover = RootDiscovery.prototype.discover;
			let releaseGate: () => void = () => {};
			let markGated: () => void = () => {};
			const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
			const gated = new Promise<void>((resolve) => { markGated = resolve; });
			let secondRunStarted = false;
			RootDiscovery.prototype.discover = async function (...args: Parameters<typeof originalDiscover>) {
				// settled capture 入口用专属 reason "settled-capture"，与输入前 capture 区分。
				if (secondRunStarted && args[1] === "settled-capture") {
					markGated();
					await gate;
				}
				return originalDiscover.apply(this, args);
			};
			try {
				// 第二轮：先写文件，再慢速输出（使得 abort 落在输出期间）。
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path: "value.txt", content: "intermediate\n" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("慢速输出".repeat(2_000)),
				]);
				secondRunStarted = true;
				const runPromise = session.prompt("慢慢输出");
				await vi.waitFor(() => expect(session.isIdle).toBe(false), { timeout: 5_000 });
				// 等待 write 工具真正落盘，避免输入前快照耗时变化导致 abort 早于写入。
				await vi.waitFor(async () => expect(await readValue(temp.workspace)).toBe("intermediate\n"), { timeout: 5_000 });

				// 中断后立即发起 /undo；gate 连第二轮检查点入栈也平行防护。
				await session.abort();
				const undoPromise = session.prompt("/undo");

				// 等到第二轮 settled capture 被阻塞，此时用户立即输入 undo。
				await Promise.race([gated, delay(5_000)]);
				expect(await readValue(temp.workspace)).toBe("intermediate\n");

				// 放开 gate，允许第二轮检查点入栈；undo 应等待并撤回第二轮（intermediate → after）。
				releaseGate();
				await Promise.all([runPromise, undoPromise]);
				expect(await readValue(temp.workspace)).toBe("after\n");
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
