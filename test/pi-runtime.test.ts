import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum } from "../src/encoding.ts";
import type { CheckpointRecord, CursorState, ManifestId, SessionFileIdentity } from "../src/model.ts";
import { createPiUndoRuntime } from "../src/pi-runtime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi runtime restart", () => {
	it("从当前 branch 的可信 checkpoint 恢复 undo 栈", async () => {
		const fixture = await runtimeFixture("checkpoint");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(runtime.controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("从 undo cursor 前缀恢复 checkpoint 对应的 redo safety manifest", async () => {
		const fixture = await runtimeFixture("cursor");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(runtime.controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
	});

	it("barrier 比最后 checkpoint 新时保持 history paused", async () => {
		const fixture = await runtimeFixture("barrier");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(await runtime.controller.undo()).toEqual({ code: "history_paused", changedFiles: 0 });
	});

	it("从连续 undo cursor 前缀恢复完整 redo frontier", async () => {
		const fixture = await runtimeFixture("two-cursors");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(runtime.controller.history()).toEqual({ undoCount: 0, redoCount: 2, locked: false });
	});

	it("忽略 fork 或 import 复制来的旧 session cursor", async () => {
		const fixture = await runtimeFixture("foreign-cursor");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(runtime.controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("redo cursor 与 checkpoint entry 为 sibling 时仍从可信 checkpoint branch 重建 undo frontier", async () => {
		const fixture = await runtimeFixture("redo-cursor");
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(runtime.controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});
});

describe("Pi runtime cursor durability", () => {
	it("append cursor 后使用最新 leaf 校验当前 branch", async () => {
		const fixture = await liveOperationFixture();
		const runtime = await createPiUndoRuntime(fixture.context as any, fixture.pi as any);

		expect(await runtime.controller.prepareInput("创建文件", { streaming: false })).toEqual({ action: "continue" });
		await runtime.controller.beforeAgentStart();
		const startEntryId = fixture.manager.getLeafId();
		fixture.appendSessionEntry({
			type: "message",
			id: "user-live",
			parentId: startEntryId,
			message: { role: "user", content: "创建文件" },
		});
		await writeFile(join(fixture.workspace, "created.txt"), "created\n");
		fixture.appendSessionEntry({
			type: "message",
			id: "assistant-live",
			parentId: "user-live",
			message: { role: "assistant", content: [] },
		});
		await runtime.controller.agentSettled();
		runtime.setCommandContext(fixture.commandContext as any);

		expect(await runtime.controller.undo()).toEqual({ code: "ok", changedFiles: 1, refillPrompt: "创建文件" });
		expect(runtime.controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
	});
});

async function liveOperationFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-runtime-live-"));
	temporaryRoots.push(root);
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
	const sessionFile = join(sessionDir, "session.jsonl");
	const header = { type: "session", id: "session-live", timestamp: "2026-07-26T00:00:00.000Z", cwd: workspace };
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`);
	const entries: any[] = [];
	let leafId: string | null = null;
	const appendSessionEntry = (entry: any) => {
		entries.push(entry);
		leafId = entry.id;
		appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	};
	const manager = {
		getEntries: () => entries,
		getLeafId: () => leafId,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getSessionFile: () => sessionFile,
		getSessionDir: () => sessionDir,
		getSessionId: () => "session-live",
		getHeader: () => header,
	};
	const context = {
		cwd: workspace,
		mode: "tui",
		sessionManager: manager,
		isIdle: () => true,
		abort: () => {},
		ui: {
			setStatus: () => {},
			notify: () => {},
			getEditorText: () => "",
			setEditorText: () => {},
		},
	};
	const pi = {
		appendEntry(customType: string, data: unknown) {
			appendSessionEntry({
				type: "custom",
				id: `entry-${entries.length}`,
				parentId: leafId,
				customType,
				data,
			});
		},
	};
	const commandContext = {
		async navigateTree(targetId: string) {
			const target = manager.getEntry(targetId);
			leafId = target?.message?.role === "user" ? target.parentId : targetId;
			return { cancelled: false };
		},
	};
	return { workspace, context, pi, manager, commandContext, appendSessionEntry };
}

async function runtimeFixture(scenario: "checkpoint" | "cursor" | "barrier" | "two-cursors" | "foreign-cursor" | "redo-cursor") {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-runtime-"));
	temporaryRoots.push(root);
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
	const sessionFile = join(sessionDir, "session.jsonl");
	const header = { type: "session", id: "session-1", timestamp: "2026-07-25T00:00:00.000Z", cwd: workspace };
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`);
	const identity = sessionIdentity(sessionFile, header);
	const checkpoint = checkpointRecord(identity, 1);
	const entries: any[] = [
		{ type: "custom", id: "start-1", parentId: null, customType: "pi-undo:start", data: {} },
		{ type: "message", id: "user-1", parentId: "start-1", message: { role: "user", content: "prompt" } },
		{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [] } },
		{ type: "custom", id: "checkpoint-entry", parentId: "assistant-1", customType: "pi-undo:checkpoint", data: checkpoint },
	];
	let leafId = "checkpoint-entry";
	if (scenario === "cursor") {
		entries.push({
			type: "custom",
			id: "cursor-entry",
			parentId: "start-1",
			customType: "pi-undo:cursor",
			data: cursorState(identity, {
				opId: "undo-operation-1",
				redoStack: [checkpoint.checkpointId],
				rollbackManifestId: "d".repeat(64) as ManifestId,
			}),
		});
		leafId = "cursor-entry";
	} else if (scenario === "barrier") {
		entries.push({
			type: "custom",
			id: "barrier-entry",
			parentId: "checkpoint-entry",
			customType: "pi-undo:barrier",
			data: { reason: "settled_capture_failed" },
		});
		leafId = "barrier-entry";
	} else if (scenario === "two-cursors") {
		const secondCheckpoint = checkpointRecord(identity, 2);
		entries.push(
			{ type: "custom", id: "start-2", parentId: "checkpoint-entry", customType: "pi-undo:start", data: {} },
			{ type: "message", id: "user-2", parentId: "start-2", message: { role: "user", content: "prompt 2" } },
			{ type: "message", id: "assistant-2", parentId: "user-2", message: { role: "assistant", content: [] } },
			{ type: "custom", id: "checkpoint-entry-2", parentId: "assistant-2", customType: "pi-undo:checkpoint", data: secondCheckpoint },
			{
				type: "custom",
				id: "cursor-entry-1",
				parentId: "start-2",
				customType: "pi-undo:cursor",
				data: cursorState(identity, {
					opId: "undo-operation-1",
					undoHead: checkpoint.checkpointId,
					redoStack: [secondCheckpoint.checkpointId],
					rollbackManifestId: "e".repeat(64) as ManifestId,
				}),
			},
			{
				type: "custom",
				id: "cursor-entry-2",
				parentId: "start-1",
				customType: "pi-undo:cursor",
				data: cursorState(identity, {
					opId: "undo-operation-2",
					redoStack: [secondCheckpoint.checkpointId, checkpoint.checkpointId],
					rollbackManifestId: "f".repeat(64) as ManifestId,
				}),
			},
		);
		leafId = "cursor-entry-2";
	} else if (scenario === "foreign-cursor") {
		const foreignIdentity = { ...identity, path: join(sessionDir, "old-session.jsonl") };
		entries.push({
			type: "custom",
			id: "foreign-cursor-entry",
			parentId: "checkpoint-entry",
			customType: "pi-undo:cursor",
			data: cursorState(foreignIdentity, {
				opId: "foreign-undo-operation",
				redoStack: [checkpoint.checkpointId],
				rollbackManifestId: "d".repeat(64) as ManifestId,
			}),
		});
		leafId = "foreign-cursor-entry";
	} else if (scenario === "redo-cursor") {
		entries.push({
			type: "custom",
			id: "redo-cursor-entry",
			parentId: "assistant-1",
			customType: "pi-undo:cursor",
			data: cursorState(identity, {
				opId: "redo-operation-1",
				action: "redo",
				toLogicalLeaf: "assistant-1",
				undoHead: checkpoint.checkpointId,
				redoStack: [],
				rollbackManifestId: "d".repeat(64) as ManifestId,
			}),
		});
		leafId = "redo-cursor-entry";
	}
	const manager = {
		getEntries: () => entries,
		getLeafId: () => leafId,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getSessionFile: () => sessionFile,
		getSessionDir: () => sessionDir,
		getSessionId: () => "session-1",
		getHeader: () => header,
	};
	const context = {
		cwd: workspace,
		mode: "tui",
		sessionManager: manager,
		isIdle: () => true,
		abort: () => {},
		ui: {
			setStatus: () => {},
			notify: () => {},
			getEditorText: () => "",
			setEditorText: () => {},
		},
	};
	const pi = {
		appendEntry(customType: string, data: unknown) {
			const id = `entry-${entries.length}`;
			entries.push({ type: "custom", id, parentId: leafId, customType, data });
			leafId = id;
		},
	};
	return { context, pi };
}

function sessionIdentity(sessionFile: string, header: { id: string; timestamp: string; cwd: string }): SessionFileIdentity {
	return {
		path: resolve(sessionFile),
		headerChecksum: checksum(canonicalJson({ id: header.id, timestamp: header.timestamp, cwd: header.cwd })),
	};
}

function checkpointRecord(identity: SessionFileIdentity, index: number): CheckpointRecord {
	const payload = {
		schemaVersion: 1 as const,
		checkpointId: `checkpoint-${index}`,
		runId: `run-${index}`,
		sessionIdentity: identity,
		startEntryId: `start-${index}`,
		userEntryId: `user-${index}`,
		endLeafId: `assistant-${index}`,
		rawPrompt: `prompt ${index}`,
		beforeManifestId: (index === 1 ? "a" : "b").repeat(64) as ManifestId,
		afterManifestId: (index === 1 ? "b" : "c").repeat(64) as ManifestId,
		changedPaths: [`file-${index}.txt`],
	};
	return { ...payload, checksum: checksum(canonicalJson(payload)) };
}

function cursorState(
	identity: SessionFileIdentity,
	options: {
		readonly opId: string;
		readonly action?: "undo" | "redo";
		readonly toLogicalLeaf?: string | null;
		readonly undoHead?: string | null;
		readonly redoStack: readonly string[];
		readonly rollbackManifestId: ManifestId;
	},
): CursorState {
	const payload = {
		schemaVersion: 1 as const,
		opId: options.opId,
		action: options.action ?? "undo",
		sessionIdentity: identity,
		fromLogicalLeaf: "assistant-1",
		toLogicalLeaf: options.toLogicalLeaf ?? null,
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: options.rollbackManifestId,
		undoHead: options.undoHead ?? null,
		redoStack: options.redoStack,
		descriptorChecksum: "c".repeat(64),
	};
	return { ...payload, checksum: checksum(canonicalJson(payload)) };
}
