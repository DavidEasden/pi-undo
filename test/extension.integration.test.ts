import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { createPiUndoExtension } from "../extensions/pi-undo.ts";
import { StatusReporter } from "../src/status-reporter.ts";

describe("pi-undo extension", () => {
	it("注册 undo 和 redo 命令", () => {
		const commandDescriptions = new Map<string, string | undefined>();
		const pi = {
			registerCommand(name: string, options: { description?: string }): void {
				commandDescriptions.set(name, options.description);
			},
			on(): void {},
		} as unknown as ExtensionAPI;

		extension(pi);

		expect([...commandDescriptions.keys()].sort()).toEqual(["redo", "undo"]);
		expect(commandDescriptions.get("undo")).toContain("last completed Agent run");
	});

	it("绑定完整 lifecycle，并在 session replacement 后丢弃 stale command 结果", async () => {
		const handlers = new Map<string, (event: any, context: any) => any>();
		const commands = new Map<string, (args: string, context: any) => Promise<void>>();
		const notifications: string[] = [];
		let finishUndo: ((value: { code: "ok"; changedFiles: number }) => void) | undefined;
		let generation = 0;
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) {
				commands.set(name, options.handler);
			},
			on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI;
		const bind = createPiUndoExtension(async (context) => {
			generation += 1;
			return {
				controller: {
					history: () => ({ undoCount: 1, redoCount: 0, locked: false }),
					recover: async () => {},
					prepareInput: async () => ({ action: "continue" as const }),
					beforeAgentStart: async () => {},
					agentSettled: async () => {},
					undo: async () => new Promise((resolve) => { finishUndo = resolve; }),
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
		await handlers.get("session_start")!({ type: "session_start" }, context);
		finishUndo!({ code: "ok", changedFiles: 1 });
		await command;

		expect(generation).toBe(2);
		expect(notifications).toEqual([]);
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
		reporter.clear();

		expect(fake.statuses.map(([key]) => key)).toEqual(["pi-undo", "pi-undo", "pi-undo", "pi-undo"]);
		expect(fake.statuses[0]![1]).toContain("undo:2");
		expect(fake.statuses[1]![1]).not.toMatch(/[\n\r\u0007]|private|secret|TOKEN/);
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
