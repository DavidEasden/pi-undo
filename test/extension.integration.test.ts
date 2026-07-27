import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { createPiUndoExtension } from "../extensions/pi-undo.ts";
import type { OperationResult } from "../src/controller.ts";
import { StatusReporter } from "../src/status-reporter.ts";

function deferredPromptHarness() {
	const handlers = new Map<string, (event: any, context: any) => any>();
	const commands = new Map<string, (args: string, context: any) => Promise<void>>();
	const sent: Array<string | any[]> = [];
	const replayInputs: Promise<unknown>[] = [];
	let editor = "";
	let operationInFlight = false;
	let locked = false;
	let markStarted: (() => void) | undefined;
	let finishOperation: ((result: OperationResult) => void) | undefined;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const result = new Promise<OperationResult>((resolve) => { finishOperation = resolve; });
	const context = {
		mode: "tui" as const,
		ui: {
			setStatus: () => {},
			notify: () => {},
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
		},
	};
	const runOperation = async () => {
		operationInFlight = true;
		markStarted!();
		const operationResult = await result;
		operationInFlight = false;
		if (operationResult.code === "recovery_required") locked = true;
		return operationResult;
	};
	const controller = {
		history: () => ({ undoCount: 1, redoCount: 0, locked }),
		listCheckpoints: () => [],
		recover: async () => {},
		prepareInput: async () => ({ action: operationInFlight ? "defer" as const : locked ? "handled" as const : "continue" as const }),
		beforeAgentStart: async () => {},
		agentSettled: async () => {},
		undo: runOperation,
		redo: runOperation,
		beforeTree: async () => undefined,
		afterTree: async () => {},
	};
	const pi = {
		registerCommand(name: string, options: { handler: (args: string, commandContext: any) => Promise<void> }) {
			commands.set(name, options.handler);
		},
		on(name: string, handler: (event: any, eventContext: any) => any) { handlers.set(name, handler); },
		sendUserMessage(content: string | any[]) {
			sent.push(content);
			const text = typeof content === "string"
				? content
				: content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const images = typeof content === "string" ? undefined : content.filter((part) => part.type === "image");
			replayInputs.push(Promise.resolve(
				handlers.get("input")!({ text, images, source: "extension" }, context),
			).then(async (inputResult) => {
				if (inputResult?.action === "continue") {
					await handlers.get("before_agent_start")!({ prompt: `transformed:${text}`, images }, context);
				}
			}));
		},
	} as unknown as ExtensionAPI;
	createPiUndoExtension(async () => ({ controller, reporter: new StatusReporter(context) }))(pi);

	return {
		commands,
		context,
		handlers,
		sent,
		started,
		finish: (operationResult: OperationResult) => finishOperation!(operationResult),
		get editor() { return editor; },
		async flushReplay() {
			await Promise.resolve();
			while (replayInputs.length > 0) await Promise.all(replayInputs.splice(0));
			await Promise.resolve();
		},
	};
}

describe("pi-undo extension", () => {
	it("注册 undo、redo 和 diff 命令", () => {
		const commandDescriptions = new Map<string, string | undefined>();
		const pi = {
			registerCommand(name: string, options: { description?: string }): void {
				commandDescriptions.set(name, options.description);
			},
			on(): void {},
		} as unknown as ExtensionAPI;

		extension(pi);

		expect([...commandDescriptions.keys()].sort()).toEqual(["diff", "redo", "undo"]);
		expect(commandDescriptions.get("undo")).toContain("last completed Agent run");
		expect(commandDescriptions.get("diff")).toContain("Review files changed");
	});

	it("绑定完整 lifecycle，并在 session replacement 后丢弃 stale command 结果", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		const commands = new Map<string, (args: string, context: any) => Promise<void>>();
		const notifications: string[] = [];
		const sent: unknown[] = [];
		let finishUndo: ((value: { code: "ok"; changedFiles: number }) => void) | undefined;
		let generation = 0;
		let oldOperationInFlight = false;
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) {
				commands.set(name, options.handler);
			},
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
			sendUserMessage(content: unknown) { sent.push(content); },
		} as unknown as ExtensionAPI;
		const bind = createPiUndoExtension(async (context) => {
			generation += 1;
			const runtimeGeneration = generation;
			return {
				controller: {
					history: () => ({ undoCount: 1, redoCount: 0, locked: false }),
					listCheckpoints: () => [],
					recover: async () => {},
					prepareInput: async () => ({
						action: runtimeGeneration === 1 && oldOperationInFlight ? "defer" as const : "continue" as const,
					}),
					beforeAgentStart: async () => {},
					agentSettled: async () => {},
					undo: async () => new Promise((resolve) => {
						oldOperationInFlight = true;
						finishUndo = (value) => { oldOperationInFlight = false; resolve(value); };
					}),
					redo: async () => ({ code: "noop" as const, changedFiles: 0 }),
					beforeTree: async () => undefined,
					afterTree: async () => {},
				},
				reporter: new StatusReporter(context),
			};
		});
		bind(pi);
		const context = {
			mode: "tui" as const,
			ui: {
				setStatus: () => {},
				notify: (message: string) => { notifications.push(message); },
				getEditorText: () => "",
				setEditorText: () => {},
			},
		};

		expect([...handlers.keys()].sort()).toEqual([
			"agent_settled", "before_agent_start", "input", "session_before_tree", "session_shutdown", "session_start", "session_tree",
		]);
		await handlers.get("session_start")!({ type: "session_start" }, context);
		const command = commands.get("undo")!("", context);
		expect(await handlers.get("input")!({ text: "旧 session 输入", source: "interactive" }, context))
			.toEqual({ action: "handled" });
		await handlers.get("session_start")!({ type: "session_start" }, context);
		finishUndo!({ code: "ok", changedFiles: 1 });
		await command;

		expect(generation).toBe(2);
		expect(notifications).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("undo 期间暂存文本、文件引用与图片，并在完成后按 agent_settled 串行重放", async () => {
		const fixture = deferredPromptHarness();
		await fixture.handlers.get("session_start")!({}, fixture.context);
		const command = fixture.commands.get("undo")!("", fixture.context);
		await fixture.started;
		const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

		expect(await fixture.handlers.get("input")!({
			text: "检查 @src/controller.ts",
			images: [image],
			source: "interactive",
		}, fixture.context)).toEqual({ action: "handled" });
		expect(await fixture.handlers.get("input")!({
			text: "然后更新测试",
			source: "interactive",
		}, fixture.context)).toEqual({ action: "handled" });
		expect(fixture.sent).toEqual([]);

		fixture.finish({ code: "ok", changedFiles: 1, refillPrompt: "旧 prompt" });
		await command;
		await fixture.flushReplay();
		expect(fixture.editor).toBe("");
		expect(fixture.sent).toEqual([[{ type: "text", text: "检查 @src/controller.ts" }, image]]);

		await fixture.handlers.get("agent_settled")!({}, fixture.context);
		await fixture.flushReplay();
		expect(fixture.sent).toEqual([
			[{ type: "text", text: "检查 @src/controller.ts" }, image],
			"然后更新测试",
		]);
	});

	it("redo 期间提交的新 prompt 在事务完成后自动执行", async () => {
		const fixture = deferredPromptHarness();
		await fixture.handlers.get("session_start")!({}, fixture.context);
		const command = fixture.commands.get("redo")!("", fixture.context);
		await fixture.started;
		await fixture.handlers.get("input")!({ text: "redo 后继续", source: "interactive" }, fixture.context);

		fixture.finish({ code: "ok", changedFiles: 1 });
		await command;
		await fixture.flushReplay();

		expect(fixture.sent).toEqual(["redo 后继续"]);
	});

	it("recovery lock 时恢复暂存文本但不启动 Agent", async () => {
		const fixture = deferredPromptHarness();
		await fixture.handlers.get("session_start")!({}, fixture.context);
		const command = fixture.commands.get("undo")!("", fixture.context);
		await fixture.started;
		await fixture.handlers.get("input")!({ text: "不要丢失", source: "interactive" }, fixture.context);

		fixture.finish({ code: "recovery_required", changedFiles: 0 });
		await command;
		await fixture.flushReplay();

		expect(fixture.sent).toEqual([]);
		expect(fixture.editor).toBe("不要丢失");
	});

	it("undo 期间的 slash 输入保留在 editor，不按普通文本重放", async () => {
		const fixture = deferredPromptHarness();
		await fixture.handlers.get("session_start")!({}, fixture.context);
		const command = fixture.commands.get("undo")!("", fixture.context);
		await fixture.started;

		expect(await fixture.handlers.get("input")!({
			text: "/skill:review src/controller.ts",
			source: "interactive",
		}, fixture.context)).toEqual({ action: "handled" });
		fixture.finish({ code: "ok", changedFiles: 1, refillPrompt: "旧 prompt" });
		await command;
		await fixture.flushReplay();

		expect(fixture.sent).toEqual([]);
		expect(fixture.editor).toBe("/skill:review src/controller.ts");
	});

	it("内部 undo/redo 导航绕过普通 tree hooks", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		let beforeTreeCalls = 0;
		let afterTreeCalls = 0;
		let internalNavigation = true;
		const pi = {
			registerCommand() {},
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		const context = {
			mode: "tui" as const,
			ui: {
				setStatus: () => {},
				notify: () => {},
				getEditorText: () => "",
				setEditorText: () => {},
			},
		};
		createPiUndoExtension(async () => ({
			controller: {
				history: () => ({ undoCount: 0, redoCount: 0, locked: false }),
				listCheckpoints: () => [],
				recover: async () => {},
				prepareInput: async () => ({ action: "continue" as const }),
				beforeAgentStart: async () => {},
				agentSettled: async () => {},
				undo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				redo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				beforeTree: async () => { beforeTreeCalls += 1; return undefined; },
				afterTree: async () => { afterTreeCalls += 1; },
			},
			reporter: new StatusReporter(context),
			isInternalNavigation: () => internalNavigation,
		}))(pi);
		await handlers.get("session_start")!({ type: "session_start" }, context);

		expect(await handlers.get("session_before_tree")!({ preparation: { targetId: "target" } }, context)).toBeUndefined();
		await handlers.get("session_tree")!({ newLeafId: "target" }, context);
		expect([beforeTreeCalls, afterTreeCalls]).toEqual([0, 0]);

		internalNavigation = false;
		await handlers.get("session_before_tree")!({ preparation: { targetId: "target" } }, context);
		await handlers.get("session_tree")!({ newLeafId: "target" }, context);
		expect([beforeTreeCalls, afterTreeCalls]).toEqual([1, 1]);
	});

	it("成功 undo 在空 TUI editor 中回填原始 prompt", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		const commands = new Map<string, (args: string, context: any) => Promise<void>>();
		let editor = "";
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) {
				commands.set(name, options.handler);
			},
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		const context = {
			mode: "tui" as const,
			ui: {
				setStatus: () => {},
				notify: () => {},
				getEditorText: () => editor,
				setEditorText: (text: string) => { editor = text; },
			},
		};
		createPiUndoExtension(async () => ({
			controller: {
				history: () => ({ undoCount: 0, redoCount: 1, locked: false }),
				listCheckpoints: () => [],
				recover: async () => {},
				prepareInput: async () => ({ action: "continue" as const }),
				beforeAgentStart: async () => {},
				agentSettled: async () => {},
				undo: async () => ({ code: "ok" as const, changedFiles: 1, refillPrompt: "原始 prompt" }),
				redo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				beforeTree: async () => undefined,
				afterTree: async () => {},
			},
			reporter: new StatusReporter(context),
		}))(pi);
		await handlers.get("session_start")!({ type: "session_start" }, context);

		await commands.get("undo")!("", context);

		expect(editor).toBe("原始 prompt");
	});

	it("/diff 在非 TUI 模式输出最近 run 的文件与行数摘要", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		const commands = new Map<string, (args: string, context: any) => Promise<void>>();
		const notifications: string[] = [];
		const beforeId = "a".repeat(64);
		const afterId = "b".repeat(64);
		const checkpoint = {
			beforeManifestId: beforeId,
			afterManifestId: afterId,
			changedPaths: ["src/value.ts"],
			rawPrompt: "更新 value",
		};
		const manifest = (manifestId: string) => ({
			schemaVersion: 1 as const,
			manifestId,
			workspaceIdentity: "/workspace",
			topologyFingerprint: "c".repeat(64),
			coverage: "complete",
			roots: [{
				relativeRoot: ".", parentRoot: null, state: "active" as const,
				sourceIdentity: "source", privateRepositoryId: "private", treeId: "d".repeat(40),
				coverage: "complete", ignorePolicy: "git-check-ignore-v1", ignoredPresentPaths: [],
				ignoreClosure: "e".repeat(64), objectClosure: "f".repeat(64),
			}],
			createdAt: "2026-07-26T00:00:00.000Z",
		});
		const context = {
			mode: "print" as const,
			ui: {
				setStatus: () => {},
				notify: (message: string) => { notifications.push(message); },
				getEditorText: () => "",
				setEditorText: () => {},
			},
		};
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) {
				commands.set(name, options.handler);
			},
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		createPiUndoExtension(async () => ({
			controller: {
				history: () => ({ undoCount: 1, redoCount: 0, locked: false }),
				listCheckpoints: () => [checkpoint as any],
				recover: async () => {}, prepareInput: async () => ({ action: "continue" as const }),
				beforeAgentStart: async () => {}, agentSettled: async () => {},
				undo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				redo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				beforeTree: async () => undefined, afterTree: async () => {},
			},
			reporter: new StatusReporter(context),
			diffSource: {
				loadManifest: async (id: any) => manifest(id) as any,
				listTree: async (id: any) => [{
					relativePath: "src/value.ts", kind: "file" as const, mode: 0o100644,
					blobId: id === beforeId ? "old" : "new", size: 4, rootHash: "tree",
				}],
				readBlob: async (_id: any, _root: string, blobId: string) => Buffer.from(blobId === "old" ? "old\n" : "new\n"),
			},
		}))(pi);
		await handlers.get("session_start")!({}, context);

		await commands.get("diff")!("", context);
		expect(notifications).toEqual(["Run #1: 更新 value — 1 file(s), +1 -1: src/value.ts"]);
	});

	it("/diff 在没有历史时给出提示", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		const commands = new Map<string, (args: string, context: any) => Promise<void>>();
		const notifications: string[] = [];
		const context = {
			mode: "print" as const,
			ui: { setStatus: () => {}, notify: (message: string) => { notifications.push(message); }, getEditorText: () => "", setEditorText: () => {} },
		};
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) { commands.set(name, options.handler); },
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		createPiUndoExtension(async () => ({
			controller: {
				history: () => ({ undoCount: 0, redoCount: 0, locked: false }), listCheckpoints: () => [], recover: async () => {},
				prepareInput: async () => ({ action: "continue" as const }), beforeAgentStart: async () => {}, agentSettled: async () => {},
				undo: async () => ({ code: "noop" as const, changedFiles: 0 }), redo: async () => ({ code: "noop" as const, changedFiles: 0 }),
				beforeTree: async () => undefined, afterTree: async () => {},
			},
			reporter: new StatusReporter(context), diffSource: {} as any,
		}))(pi);
		await handlers.get("session_start")!({}, context);

		await commands.get("diff")!("", context);
		expect(notifications).toEqual(["No recorded Agent runs to diff"]);
	});
});

describe("StatusReporter", () => {
	function context(mode: "tui" | "rpc" | "print" | "json", initialEditor = "") {
		let editor = initialEditor;
		const statuses: Array<[string, string | undefined]> = [];
		const notifications: Array<[string, string | undefined]> = [];
		return {
			statuses,
			notifications,
			get editor() { return editor; },
			value: {
				mode,
				ui: {
					setStatus: (key: string, text: string | undefined) => { statuses.push([key, text]); },
					notify: (text: string, type?: string) => { notifications.push([text, type]); },
					getEditorText: () => editor,
					setEditorText: (text: string) => { editor = text; },
				},
			},
		};
	}

	it("所有状态只使用 pi-undo footer key，并清理换行、路径、token 与控制字符", () => {
		const fake = context("tui");
		const reporter = new StatusReporter(fake.value);

		reporter.setReady(2, 1);
		reporter.setPhase("restoring\n/private/tmp/secret sk-testTOKEN123\u0007");
		reporter.setRecoveryRequired("broken\nstate");
		reporter.setRecoveryRequired("mutation_conflict", { files: 2, opId: "operation-1" });
		reporter.clear();

		expect(fake.statuses.map(([key]) => key)).toEqual(["pi-undo", "pi-undo", "pi-undo", "pi-undo", "pi-undo"]);
		expect(fake.statuses[0]![1]).toContain("undo:2");
		expect(fake.statuses[1]![1]).not.toMatch(/[\n\r\u0007]|private|secret|TOKEN/);
		expect(fake.statuses[3]![1]).toBe("recovery_required files:2 op:operation-1");
		expect(fake.statuses.at(-1)).toEqual(["pi-undo", undefined]);
	});

	it("操作结果使用单行 notify，并按模式安全回填 prompt", () => {
		const tui = context("tui");
		const tuiReporter = new StatusReporter(tui.value);
		tuiReporter.result({ code: "ok", changedFiles: 3, message: "done\n/path/file" });

		expect(tui.notifications[0]![0]).not.toContain("\n");
		expect(tuiReporter.refillPrompt("原始 prompt")).toBe("written");
		expect(tui.editor).toBe("原始 prompt");
		expect(new StatusReporter(context("tui", "用户正在输入").value).refillPrompt("旧 prompt")).toBe("skipped");
		expect(new StatusReporter(context("rpc").value).refillPrompt("旧 prompt")).toBe("requested");
		expect(new StatusReporter(context("print").value).refillPrompt("旧 prompt")).toBe("unsupported");
		expect(new StatusReporter(context("json").value).refillPrompt("旧 prompt")).toBe("unsupported");
	});
});
