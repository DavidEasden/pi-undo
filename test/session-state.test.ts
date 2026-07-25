import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum } from "../src/encoding.ts";
import {
	DurableCursorWriter,
	SessionState,
	type SessionEntrySource,
} from "../src/session-state.ts";
import type { CheckpointRecord, CursorState, ManifestId, SessionFileIdentity } from "../src/model.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function identity(sessionFile: string): SessionFileIdentity {
	return {
		path: resolve(sessionFile),
		headerChecksum: checksum(canonicalJson({ id: "session-1", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/workspace" })),
	};
}

function header(): Record<string, string> {
	return { type: "session", id: "session-1", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/workspace" };
}

function cursor(sessionFile: string, overrides: Partial<CursorState> = {}): CursorState {
	const payload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		action: "undo" as const,
		sessionIdentity: identity(sessionFile),
		fromLogicalLeaf: "assistant-1",
		toLogicalLeaf: "user-1",
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: "b".repeat(64) as ManifestId,
		undoHead: "checkpoint-1",
		redoStack: [],
		descriptorChecksum: "c".repeat(64),
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

function checkpoint(sessionFile: string, overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
	const payload = {
		schemaVersion: 1 as const,
		checkpointId: "checkpoint-1",
		runId: "run-1",
		sessionIdentity: identity(sessionFile),
		startEntryId: "start-1",
		userEntryId: "user-1",
		endLeafId: "assistant-1",
		rawPrompt: "修复文件",
		beforeManifestId: "a".repeat(64) as ManifestId,
		afterManifestId: "b".repeat(64) as ManifestId,
		changedPaths: ["a.txt", "nested/b.txt"],
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

class FakeSession implements SessionEntrySource {
	readonly entries: unknown[];
	leafId: string | null;
	readonly sessionFile: string | undefined;

	constructor(entries: unknown[], leafId: string | null, sessionFile?: string) {
		this.entries = entries;
		this.leafId = leafId;
		this.sessionFile = sessionFile;
	}

	getEntries(): readonly unknown[] {
		return this.entries;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionState", () => {
	it("递归跳过全部 pi-undo 控制 entry，并将 cursor parent 作为 logical leaf", () => {
		const entries = [
			{ type: "message", id: "user-1", parentId: null, message: { role: "user" } },
			{ type: "custom", id: "start", parentId: "user-1", customType: "pi-undo:start" },
			{ type: "message", id: "assistant-1", parentId: "start", message: { role: "assistant" } },
			{ type: "custom", id: "checkpoint", parentId: "assistant-1", customType: "pi-undo:checkpoint" },
			{ type: "custom", id: "future", parentId: "checkpoint", customType: "pi-undo:future-control" },
			{ type: "custom", id: "cursor", parentId: "future", customType: "pi-undo:cursor" },
		];
		const state = new SessionState(new FakeSession(entries, "cursor"));

		expect(state.getLogicalLeafId()).toBe("assistant-1");
		expect(state.getActiveBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
	});

	it("parent cycle 或 orphan 不能静默进入 active branch", () => {
		const cyclic = new SessionState(new FakeSession([
			{ type: "message", id: "a", parentId: "b", message: { role: "user" } },
			{ type: "message", id: "b", parentId: "a", message: { role: "assistant" } },
		], "a"));
		const orphan = new SessionState(new FakeSession([
			{ type: "message", id: "a", parentId: "missing", message: { role: "user" } },
		], "a"));

		expect(() => cyclic.getActiveBranch()).toThrow("cycle");
		expect(() => orphan.getActiveBranch()).toThrow("parent");
	});

	it("fork/import 携带旧会话的 cursor 时，只接受当前可信 session identity", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const oldIdentity: SessionFileIdentity = {
			path: resolve(join(root, "old-session.jsonl")),
			headerChecksum: "d".repeat(64),
		};
		const oldCursor = cursor(sessionFile, { sessionIdentity: oldIdentity });
		const state = new SessionState(new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
			{ type: "custom", id: "old-cursor", parentId: "assistant-1", customType: "pi-undo:cursor", data: oldCursor },
		], "old-cursor", sessionFile));

		const currentIdentity = await state.getSessionIdentity();

		expect(currentIdentity).toEqual(identity(sessionFile));
		expect(state.getCursor(currentIdentity!)).toBeNull();
	});

	it("后续 start/checkpoint 会覆盖祖先 cursor，避免重启后复活旧 redo frontier", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const oldCursor = cursor(sessionFile);
		const state = new SessionState(new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
			{ type: "custom", id: "old-cursor", parentId: "assistant-1", customType: "pi-undo:cursor", data: oldCursor },
			{ type: "custom", id: "start-2", parentId: "old-cursor", customType: "pi-undo:start", data: {} },
			{ type: "message", id: "user-2", parentId: "start-2", message: { role: "user" } },
		], "user-2", sessionFile));

		expect(state.getCursor(identity(sessionFile))).toBeNull();
	});

	it("只接纳当前身份、字段完整、校验和正确且链路顺序可信的 checkpoint", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const trusted = checkpoint(sessionFile);
		const state = new SessionState(new FakeSession([
			{ type: "custom", id: "start-1", parentId: null, customType: "pi-undo:start" },
			{ type: "message", id: "user-1", parentId: "start-1", message: { role: "user" } },
			{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant" } },
			{ type: "custom", id: "checkpoint-entry", parentId: "assistant-1", customType: "pi-undo:checkpoint", data: trusted },
		], "checkpoint-entry", sessionFile));

		expect(state.getCheckpoints(identity(sessionFile))).toEqual([trusted]);
		expect(state.findUserEntry("checkpoint-1", identity(sessionFile))).toBe("user-1");
		expect(await state.findTargetManifest("checkpoint-1", identity(sessionFile))).toBe(trusted.afterManifestId);
	});

	it("安全忽略 checksum、规范 changedPaths、链路顺序或 session identity 不可信的 checkpoint", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const invalidChecksum = checkpoint(sessionFile, { checkpointId: "bad-checksum", checksum: "0".repeat(64) });
		const invalidPaths = checkpoint(sessionFile, { checkpointId: "bad-paths", changedPaths: ["z.txt", "a.txt"] });
		const invalidOrder = checkpoint(sessionFile, { checkpointId: "bad-order", startEntryId: "assistant-1", userEntryId: "user-1" });
		const oldIdentity = checkpoint(sessionFile, {
			checkpointId: "old-session",
			sessionIdentity: { path: "/old/session.jsonl", headerChecksum: "c".repeat(64) },
		});
		const trusted = checkpoint(sessionFile, { checkpointId: "trusted" });
		const entries = [
			{ type: "custom", id: "start-1", parentId: null, customType: "pi-undo:start" },
			{ type: "message", id: "user-1", parentId: "start-1", message: { role: "user" } },
			{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant" } },
			{ type: "custom", id: "bad-checksum-entry", parentId: "assistant-1", customType: "pi-undo:checkpoint", data: invalidChecksum },
			{ type: "custom", id: "bad-paths-entry", parentId: "bad-checksum-entry", customType: "pi-undo:checkpoint", data: invalidPaths },
			{ type: "custom", id: "bad-order-entry", parentId: "bad-paths-entry", customType: "pi-undo:checkpoint", data: invalidOrder },
			{ type: "custom", id: "old-session-entry", parentId: "bad-order-entry", customType: "pi-undo:checkpoint", data: oldIdentity },
			{ type: "custom", id: "trusted-entry", parentId: "old-session-entry", customType: "pi-undo:checkpoint", data: trusted },
		];
		const state = new SessionState(new FakeSession(entries, "trusted-entry", sessionFile));

		// API 契约：坏记录仅被排除，不能让历史读取本身变成一次恢复事务。
		expect(state.getCheckpoints(identity(sessionFile))).toEqual([trusted]);
		expect(() => state.findUserEntry("bad-order", identity(sessionFile))).toThrow("checkpoint 不在 active branch");
	});

	it("changedPaths 即使形式规范，也不能包含用户 Git 元数据路径", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const metadataPath = checkpoint(sessionFile, { changedPaths: [".git/config"] });
		const state = new SessionState(new FakeSession([
			{ type: "custom", id: "start-1", parentId: null, customType: "pi-undo:start" },
			{ type: "message", id: "user-1", parentId: "start-1", message: { role: "user" } },
			{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant" } },
			{ type: "custom", id: "checkpoint-entry", parentId: "assistant-1", customType: "pi-undo:checkpoint", data: metadataPath },
		], "checkpoint-entry", sessionFile));

		expect(state.getCheckpoints(identity(sessionFile))).toEqual([]);
	});

	it("checkpoint 必须绑定当前 run 的 user parent 与实际 end logical leaf", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const staleEnd = checkpoint(sessionFile);
		const wrongUserParent = checkpoint(sessionFile, {
			checkpointId: "wrong-user-parent",
			userEntryId: "user-2",
			endLeafId: "assistant-2",
		});
		const state = new SessionState(new FakeSession([
			{ type: "custom", id: "start-1", parentId: null, customType: "pi-undo:start" },
			{ type: "message", id: "user-1", parentId: "start-1", message: { role: "user" } },
			{ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant" } },
			{ type: "message", id: "assistant-later", parentId: "assistant-1", message: { role: "assistant" } },
			{ type: "custom", id: "stale-end-entry", parentId: "assistant-later", customType: "pi-undo:checkpoint", data: staleEnd },
			{ type: "message", id: "user-2", parentId: "stale-end-entry", message: { role: "user" } },
			{ type: "message", id: "assistant-2", parentId: "user-2", message: { role: "assistant" } },
			{ type: "custom", id: "wrong-parent-entry", parentId: "assistant-2", customType: "pi-undo:checkpoint", data: wrongUserParent },
		], "wrong-parent-entry", sessionFile));

		expect(state.getCheckpoints(identity(sessionFile))).toEqual([]);
	});
});

describe("DurableCursorWriter", () => {
	it("--no-session 或尚未物化的 Pi session 只返回 volatile，不创建文件也不 append", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "deferred.jsonl");
		const session = new FakeSession([], null, sessionFile);
		let appended = false;
		const writer = new DurableCursorWriter();

		const result = await writer.appendCursor(cursor(sessionFile), {
			appendEntry: () => { appended = true; },
		}, session);

		expect(result).toEqual({ kind: "volatile", reason: "session_file_unavailable" });
		expect(appended).toBe(false);
		await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("完整无 LF cursor marker 补 LF、fsync 后才返回 durable", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const session = new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
		], "assistant-1", sessionFile);
		const state = cursor(sessionFile, { toLogicalLeaf: "assistant-1" });
		const writer = new DurableCursorWriter();

		const result = await writer.appendCursor(state, {
			appendEntry: async (customType, data) => {
				session.entries.push({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data });
				session.leafId = "cursor-1";
				await appendFile(sessionFile, JSON.stringify({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data }));
			},
		}, session);

		expect(result).toEqual({ kind: "durable", logicalLeafId: "assistant-1" });
		 expect((await readFile(sessionFile, "utf8")).endsWith("\n")).toBe(true);
	});

	it("磁盘已有 marker 但当前 physical branch 没有该 cursor 时进入 recovery lock", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const state = cursor(sessionFile, { toLogicalLeaf: "assistant-1" });
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const session = new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
		], "assistant-1", sessionFile);

		const result = await new DurableCursorWriter().appendCursor(state, {
			appendEntry: async (customType, data) => {
				await appendFile(sessionFile, `${JSON.stringify({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data })}\n`);
			},
		}, session);

		expect(result).toEqual({ kind: "recovery_required", reason: "cursor_missing" });
	});

	it("当前 branch 中同一 opId/checksum 的 cursor 必须唯一", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const state = cursor(sessionFile, { toLogicalLeaf: "assistant-1" });
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const session = new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
		], "assistant-1", sessionFile);

		const result = await new DurableCursorWriter().appendCursor(state, {
			appendEntry: async (customType, data) => {
				session.entries.push(
					{ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data },
					{ type: "custom", id: "cursor-2", parentId: "cursor-1", customType, data },
				);
				session.leafId = "cursor-2";
				await appendFile(sessionFile, `${JSON.stringify({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data })}\n`);
			},
		}, session);

		expect(result).toEqual({ kind: "recovery_required", reason: "cursor_conflict" });
	});

	it("cursor 的父链 logical leaf 必须等于持久化 state 的目标 leaf", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		const state = cursor(sessionFile, { toLogicalLeaf: "user-1" });
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const session = new FakeSession([
			{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant" } },
		], "assistant-1", sessionFile);

		const result = await new DurableCursorWriter().appendCursor(state, {
			appendEntry: async (customType, data) => {
				session.entries.push({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data });
				session.leafId = "cursor-1";
				await appendFile(sessionFile, `${JSON.stringify({ type: "custom", id: "cursor-1", parentId: "assistant-1", customType, data })}\n`);
			},
		}, session);

		expect(result).toEqual({ kind: "recovery_required", reason: "cursor_conflict" });
	});

	it("append 抛错而未找到 marker 时进入 recovery lock，不信任 ghost memory leaf", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify(header())}\n`);
		const session = new FakeSession([], "ghost-leaf", sessionFile);
		const writer = new DurableCursorWriter();

		const result = await writer.appendCursor(cursor(sessionFile), {
			appendEntry: () => { throw new Error("disk failed after Pi advanced memory leaf"); },
		}, session);

		expect(result).toEqual({ kind: "recovery_required", reason: "append_ambiguous" });
	});

	it("身份不匹配时不追加 cursor", async () => {
		const root = await temporaryRoot("pi-undo-session-");
		const sessionFile = join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ ...header(), id: "other-session" })}\n`);
		const session = new FakeSession([], null, sessionFile);
		let appended = false;

		const result = await new DurableCursorWriter().appendCursor(cursor(sessionFile), {
			appendEntry: () => { appended = true; },
		}, session);

		expect(result).toEqual({ kind: "recovery_required", reason: "session_identity_mismatch" });
		expect(appended).toBe(false);
	});
});
