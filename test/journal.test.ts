import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import type { MutationJournal } from "../src/mutation-journal.ts";

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

function inertPlan() {
	const payload = {
		boundaryRoots: [],
		currentManifestId: "b".repeat(64) as ManifestId,
		deletePaths: [],
		scopePaths: [],
		targetManifestId: "a".repeat(64) as ManifestId,
		writePaths: [],
	};
	return { ...payload, planDigest: checksum(canonicalJson(payload)) };
}

function inertDescriptor(path: string, planDigest: string): OperationDescriptor {
	return descriptor(path, {
		coverage: `paths:${checksum(canonicalJson([]))}`,
		scopePaths: [],
		planDigest,
	});
}

async function inertFixture(plan = inertPlan()) {
	const root = await temporaryRoot("pi-undo-inert-journal-");
	const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
	const operation = inertDescriptor(join(root, "session.jsonl"), plan.planDigest);
	await store.prepare(operation, plan);
	const [pending] = await store.loadPending();
	if (pending === undefined) throw new Error("测试 fixture 未生成 pending journal");
	return { root, store, operation, plan, pending };
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

describe("foreign PREPARED transaction", () => {
	it("严格空 plan 即使存在 transaction 目录外 artifact 也可证明 inert", async () => {
		const { root, store, pending } = await inertFixture();
		await mkdir(join(root, "durable-cache", "shared"), { recursive: true });
		await writeFile(join(root, "durable-cache", "shared", "durable-pack-v1.bin"), "unrelated cache");
		await writeFile(join(root, "native-request-v1.json"), "unrelated request");

		expect(await store.isInertForeignPrepared(pending)).toBe(true);
	});

	it("transaction 目录中的 mutation、durable pack 或额外文件都会 fail closed", async () => {
		const extras = ["durable-pack-v1.bin", "native-request-v1.json", "unexpected.txt"];
		for (const extra of extras) {
			const { root, operation, store, pending } = await inertFixture();
			await writeFile(join(root, "transactions", operation.opId, extra), "unexpected");
			expect(await store.isInertForeignPrepared(pending)).toBe(false);
		}
	});

	it("mutation journal evidence 和 transaction 内符号链接都不能被忽略", async () => {
		const mutation = await inertFixture();
		await mutation.store.mutationJournal(mutation.operation.opId).begin({
			kind: "delete",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-source",
			targetArtifact: null,
			sourceFingerprint: "c".repeat(64),
			targetFingerprint: "d".repeat(64),
		});
		expect(await mutation.store.isInertForeignPrepared(mutation.pending)).toBe(false);

		const linked = await inertFixture();
		const descriptorPath = join(linked.root, "transactions", linked.operation.opId, "descriptor.json");
		const externalDescriptor = join(linked.root, "outside.json");
		await writeFile(externalDescriptor, canonicalJson(linked.operation));
		await rm(descriptorPath);
		await symlink(externalDescriptor, descriptorPath);
		expect(await linked.store.isInertForeignPrepared(linked.pending)).toBe(false);
	});

	it("transaction 目录被外部目录符号链接替换时 fail closed", async () => {
		const { root, store, operation, pending } = await inertFixture();
		const directory = join(root, "transactions", operation.opId);
		const external = join(root, "moved-transaction");
		await rename(directory, external);
		await symlink(external, directory);

		expect(await store.isInertForeignPrepared(pending)).toBe(false);
	});

	it("非空 scope、phase 变化和 plan 内容变化都不能通过 inert 检查", async () => {
		const scopedRoot = await temporaryRoot("pi-undo-scoped-journal-");
		const scopedStore = new JournalStore({ transactionsRoot: join(scopedRoot, "transactions") });
		const scopedOperation = descriptor(join(scopedRoot, "session.jsonl"));
		await scopedStore.prepare(scopedOperation, { planDigest: scopedOperation.planDigest });
		const [scopedPending] = await scopedStore.loadPending();
		if (scopedPending === undefined) throw new Error("测试 fixture 未生成 scoped pending journal");
		expect(await scopedStore.isInertForeignPrepared(scopedPending)).toBe(false);

		const phased = await inertFixture();
		await phased.store.setPhase(phased.operation.opId, "SESSION_MOVED");
		expect(await phased.store.isInertForeignPrepared(phased.pending)).toBe(false);

		const { scopePaths: _scopePaths, ...unscopedPlan } = inertPlan();
		for (const plan of [
			{ ...inertPlan(), writePaths: ["changed.txt"] },
			{ ...inertPlan(), currentManifestId: "c".repeat(64) },
			{ ...inertPlan(), unexpected: [] },
			unscopedPlan,
		]) {
			const changed = await inertFixture();
			await writeFile(
				join(changed.root, "transactions", changed.operation.opId, "restore-plan.json"),
				canonicalJson(plan),
			);
			const [current] = await changed.store.loadPending();
			if (current === undefined) throw new Error("测试 fixture 未生成篡改后的 pending journal");
			expect(await changed.store.isInertForeignPrepared(current)).toBe(false);
		}

		const invalidDigest = await inertFixture({ ...inertPlan(), planDigest: "e".repeat(64) });
		expect(await invalidDigest.store.isInertForeignPrepared(invalidDigest.pending)).toBe(false);
	});

	it("控制文件读取失败或 pending 已过期时返回 false 而不是抛错", async () => {
		const missing = await inertFixture();
		await rm(join(missing.root, "transactions", missing.operation.opId, "state.json"));
		expect(await missing.store.isInertForeignPrepared(missing.pending)).toBe(false);

		const stale = await inertFixture();
		await stale.store.setPhase(stale.operation.opId, "SESSION_MOVED");
		expect(await stale.store.isInertForeignPrepared(stale.pending)).toBe(false);
	});
});

describe("完全补偿 transaction 评估", () => {
	async function compensatedFixture() {
		const root = await temporaryRoot("pi-undo-compensated-journal-");
		const store = new JournalStore({ transactionsRoot: join(root, "transactions") });
		const operation = descriptor(join(root, "session.jsonl"));
		await store.prepare(operation, { paths: [], planDigest: operation.planDigest });
		await store.setPhase(operation.opId, "SESSION_MOVED", { observedLogicalLeaf: "before" });
		await store.setPhase(operation.opId, "APPLYING");
		await store.setPhase(operation.opId, "RECOVERY_REQUIRED");
		const [pending] = await store.loadPending();
		if (pending === undefined) throw new Error("测试 fixture 未生成 pending journal");
		return { root, store, operation, pending };
	}

	async function cleanedRecord(
		journal: MutationJournal,
		intent: Parameters<MutationJournal["begin"]>[0],
	): Promise<void> {
		const record = await journal.begin(intent);
		await journal.advanceMany(record.ordinal, [
			"SOURCE_QUARANTINED",
			"SOURCE_VERIFIED",
			"TARGET_INSTALLED",
			"TARGET_VERIFIED",
			"CLEANED",
		]);
	}

	it("零 mutation 且无 durable pack 时视为完全补偿", async () => {
		const { store, pending } = await compensatedFixture();
		expect(await store.isFullyCompensated(pending)).toBe(true);
	});

	it("零 mutation 但存在 durable pack 时 fail closed", async () => {
		const { root, store, pending } = await compensatedFixture();
		await writeFile(join(root, "transactions", pending.descriptor.opId, "durable-pack-v1.bin"), "pack");
		expect(await store.isFullyCompensated(pending)).toBe(false);
	});

	it("前向 delete 与补偿 write 的 CLEANED 记录链视为完全补偿", async () => {
		const { store, operation, pending } = await compensatedFixture();
		const journal = store.mutationJournal(operation.opId);
		await cleanedRecord(journal, {
			kind: "delete",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-forward-source",
			targetArtifact: null,
			sourceFingerprint: "a".repeat(64),
			targetFingerprint: "b".repeat(64),
		});
		await cleanedRecord(journal, {
			kind: "write",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-back-source",
			targetArtifact: ".pi-undo-q1-back-target",
			sourceFingerprint: "b".repeat(64),
			targetFingerprint: "a".repeat(64),
		});

		expect(await store.isFullyCompensated(pending)).toBe(true);
	});

	it("仅前向 CLEANED 的净变更链不算完全补偿", async () => {
		const { store, operation, pending } = await compensatedFixture();
		const journal = store.mutationJournal(operation.opId);
		await cleanedRecord(journal, {
			kind: "delete",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-forward-source",
			targetArtifact: null,
			sourceFingerprint: "a".repeat(64),
			targetFingerprint: "b".repeat(64),
		});

		expect(await store.isFullyCompensated(pending)).toBe(false);
	});

	it("记录未全部 CLEANED 时不算完全补偿", async () => {
		const { store, operation, pending } = await compensatedFixture();
		await store.mutationJournal(operation.opId).begin({
			kind: "delete",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q1-source",
			targetArtifact: null,
			sourceFingerprint: "a".repeat(64),
			targetFingerprint: "b".repeat(64),
		});

		expect(await store.isFullyCompensated(pending)).toBe(false);
	});

	it("评估期间 journal 发生变化时 fail closed", async () => {
		const { store, pending } = await compensatedFixture();
		await store.settleRecovery(pending.descriptor.opId, "ABORTED");

		expect(await store.isFullyCompensated(pending)).toBe(false);
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
