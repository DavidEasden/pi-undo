import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum } from "../src/encoding.ts";
import {
	JournalStore,
	decideRecovery,
	finalizeCursorMarker,
	inspectCursorMarkers,
} from "../src/journal.ts";
import type { CursorState, ManifestId, OperationDescriptor, SessionFileIdentity } from "../src/model.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function sessionIdentity(path: string): SessionFileIdentity {
	return {
		path,
		headerChecksum: checksum(canonicalJson({ id: "session-1", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/workspace" })),
	};
}

function descriptor(path: string, overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
	const scopePaths = ["a.txt", "nested/b.txt"];
	const payload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		sessionIdentity: sessionIdentity(path),
		workspaceIdentity: "/workspace",
		action: "undo" as const,
		fromLogicalLeaf: "after",
		toLogicalLeaf: "before",
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: "b".repeat(64) as ManifestId,
		coverage: `paths:${checksum(canonicalJson(scopePaths))}`,
		scopePaths,
		planDigest: "d".repeat(64),
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

function cursor(path: string, overrides: Partial<CursorState> = {}): CursorState {
	const payload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		action: "undo" as const,
		sessionIdentity: sessionIdentity(path),
		fromLogicalLeaf: "after",
		toLogicalLeaf: "before",
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: "b".repeat(64) as ManifestId,
		undoHead: "checkpoint-1",
		redoStack: [],
		descriptorChecksum: "e".repeat(64),
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JournalStore", () => {
	it("prepare 原子发布 descriptor、restore plan 和 PREPARED state", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const sessionFile = join(root, "session.jsonl");
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		const operation = descriptor(sessionFile);

		await store.prepare(operation, { paths: ["a.txt"], planDigest: operation.planDigest });

		const pending = await store.loadPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ descriptor: operation, state: { phase: "PREPARED", revision: 1 } });
		await expect(readFile(join(root, "transactions", operation.opId, "descriptor.json"), "utf8"))
			.resolves.toBe(canonicalJson(operation));
	});

	it("相位只能单调推进，并持久化 observed logical leaf", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const operation = descriptor(join(root, "session.jsonl"));
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		await store.prepare(operation, { paths: [], planDigest: operation.planDigest });

		await store.setPhase(operation.opId, "SESSION_MOVED", { observedLogicalLeaf: "summary-leaf" });
		await expect(store.setPhase(operation.opId, "PREPARED")).rejects.toThrow("不能回退");
		await store.setPhase(operation.opId, "APPLYING");

		const [pending] = await store.loadPending();
		expect(pending?.state).toMatchObject({ phase: "APPLYING", revision: 3, observedLogicalLeaf: "summary-leaf" });
	});

	it("相邻 phase group 一次发布并保留逻辑 revision", async () => {
		const root = await temporaryRoot("pi-undo-journal-group-");
		const sessionFile = join(root, "session.jsonl");
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		const operation = descriptor(sessionFile);
		await store.prepare(operation, { paths: ["a.txt"], planDigest: operation.planDigest });

		await store.setPhases(operation.opId, [
			{ phase: "SESSION_MOVED", observedLogicalLeaf: "before" },
			{ phase: "APPLYING" },
		]);

		const [pending] = await store.loadPending();
		expect(pending?.state).toMatchObject({
			phase: "APPLYING",
			revision: 3,
			observedLogicalLeaf: "before",
		});
	});

	it("已验证的启动恢复可以从中间 phase 原子收敛到终态", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const operation = descriptor(join(root, "session.jsonl"));
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		await store.prepare(operation, { paths: [], planDigest: operation.planDigest });
		await store.setPhase(operation.opId, "SESSION_MOVED", { observedLogicalLeaf: "before" });
		await store.setPhase(operation.opId, "APPLYING");

		await store.settleRecovery(operation.opId, "ABORTED");

		expect(await store.loadPending()).toEqual([]);
	});

	it("mutation 未清理时拒绝 transaction 终态", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const operation = descriptor(join(root, "session.jsonl"));
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		await store.prepare(operation, { paths: [], planDigest: operation.planDigest });
		await store.mutationJournal(operation.opId).begin({
			kind: "delete",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-source",
			targetArtifact: null,
			sourceFingerprint: "a".repeat(64),
			targetFingerprint: "b".repeat(64),
		});

		await expect(store.settleRecovery(operation.opId, "ABORTED")).rejects.toThrow("未清理");
		await store.setPhase(operation.opId, "SESSION_MOVED");
		await store.setPhase(operation.opId, "APPLYING");
		await store.setPhase(operation.opId, "FILES_VERIFIED");
		await store.setPhase(operation.opId, "CURSOR_COMMITTED");
		await expect(store.markCommitted(operation.opId)).rejects.toThrow("未清理");
	});

	it("没有 PREPARED state 的半成品 transaction 在启动时安全忽略", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const transactions = join(root, "transactions", "operation-1");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(transactions, { recursive: true }));
		await writeFile(join(transactions, "descriptor.json"), "{}");

		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		expect(await store.loadPending()).toEqual([]);
	});
});

describe("cursor marker", () => {
	it("完整但无末尾 LF 的 cursor marker 是 roll-forward evidence", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const sessionFile = join(root, "session.jsonl");
		const operation = descriptor(sessionFile);
		const marker = cursor(sessionFile, { descriptorChecksum: operation.checksum });
		await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "session-1" })}\n${JSON.stringify({ type: "custom", customType: "pi-undo:cursor", data: marker })}`);

		const inspection = await inspectCursorMarkers(sessionFile, operation);

		expect(inspection).toMatchObject({ kind: "match", needsTrailingNewline: true });
		expect(decideRecovery(inspection)).toEqual({ action: "roll_forward", reason: "durable_cursor" });

		if (inspection.kind !== "match") throw new Error("测试前置条件不成立");
		await finalizeCursorMarker(sessionFile, operation, inspection);
		expect(await readFile(sessionFile, "utf8")).toMatch(/\n$/);
		expect(await inspectCursorMarkers(sessionFile, operation)).toEqual({ kind: "match", needsTrailingNewline: false });
	});

	it("torn JSONL tail 不算 marker，recovery 必须 rollback", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const sessionFile = join(root, "session.jsonl");
		const operation = descriptor(sessionFile);
		await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "session-1" })}\n`);
		await appendFile(sessionFile, '{"type":"custom","customType":"pi-undo:cursor"');

		const inspection = await inspectCursorMarkers(sessionFile, operation);

		expect(inspection).toEqual({ kind: "absent" });
		expect(decideRecovery(inspection)).toEqual({ action: "rollback", reason: "cursor_absent" });
	});

	it("同一 opId 的不同 payload 或 session identity 必须锁定", async () => {
		const root = await temporaryRoot("pi-undo-journal-");
		const sessionFile = join(root, "session.jsonl");
		const operation = descriptor(sessionFile);
		const conflicting = cursor(sessionFile, {
			descriptorChecksum: "f".repeat(64),
		});
		await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "session-1" })}\n${JSON.stringify({ type: "custom", customType: "pi-undo:cursor", data: conflicting })}\n`);

		const inspection = await inspectCursorMarkers(sessionFile, operation);

		expect(inspection.kind).toBe("conflict");
		expect(decideRecovery(inspection)).toEqual({ action: "lock", reason: "cursor_conflict" });
	});
});
