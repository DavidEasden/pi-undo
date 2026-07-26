import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum } from "../src/encoding.ts";
import { JournalStore } from "../src/journal.ts";
import { MutationJournal, type MutationIntent } from "../src/mutation-journal.ts";
import type { ManifestId, MutationRecord, MutationState, OperationDescriptor } from "../src/model.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-mutations-"));
	temporaryRoots.push(root);
	return root;
}

function intent(path = "a.txt", overrides: Partial<MutationIntent> = {}): MutationIntent {
	return {
		kind: "write",
		path,
		sourceArtifact: ".a.txt.pi-undo-source",
		targetArtifact: ".a.txt.pi-undo-target",
		sourceFingerprint: "a".repeat(64),
		targetFingerprint: "b".repeat(64),
		...overrides,
	};
}

function record(
	opId: string,
	ordinal: number,
	state: MutationState,
	previousChecksum: string | null,
	overrides: Partial<MutationRecord> = {},
): MutationRecord {
	const content = {
		schemaVersion: 1 as const,
		opId,
		ordinal,
		state,
		...intent(ordinal === 1 ? "a.txt" : "b.txt", ordinal === 1 ? {} : {
			sourceArtifact: ".b.txt.pi-undo-source",
			targetArtifact: ".b.txt.pi-undo-target",
		}),
		previousChecksum,
		...overrides,
	};
	const { checksum: _checksum, ...payload } = content as typeof content & { checksum?: string };
	return { ...content, checksum: overrides.checksum ?? checksum(canonicalJson(payload)) };
}

function advancedRecord(previous: MutationRecord, state: MutationState): MutationRecord {
	const { checksum: _checksum, state: _state, ...rest } = previous;
	const content = { ...rest, state, previousChecksum: previous.checksum };
	return { ...content, checksum: checksum(canonicalJson(content)) };
}

function descriptor(path: string): OperationDescriptor {
	const content = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		sessionIdentity: { path, headerChecksum: "c".repeat(64) },
		workspaceIdentity: "/workspace",
		action: "undo" as const,
		fromLogicalLeaf: "after",
		toLogicalLeaf: "before",
		targetManifestId: "d".repeat(64) as ManifestId,
		rollbackManifestId: "e".repeat(64) as ManifestId,
		coverage: "paths:" + checksum(canonicalJson([])),
		scopePaths: [],
		planDigest: "f".repeat(64),
	};
	return { ...content, checksum: checksum(canonicalJson(content)) };
}

async function journalFixture(): Promise<{ journal: MutationJournal; file: string }> {
	const root = await temporaryRoot();
	const directory = join(root, "operation-1");
	await mkdir(directory, { recursive: true });
	return {
		journal: new MutationJournal(join(directory, "mutations.jsonl"), "operation-1"),
		file: join(directory, "mutations.jsonl"),
	};
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MutationJournal", () => {
	it("暴露不可变的 operation identity", async () => {
		const { journal } = await journalFixture();

		expect(journal.operationId).toBe("operation-1");
		expect(journal.storagePath).toMatch(/mutations\.jsonl$/);
	});

	it("begin 与 advance 追加记录，重载后返回 ordinal 最新状态", async () => {
		const { journal, file } = await journalFixture();
		const begun = await journal.begin(intent());
		const advanced = await journal.advance(1, "SOURCE_QUARANTINED");

		const reloaded = new MutationJournal(file, "operation-1");
		expect(await reloaded.load()).toEqual([advanced]);
		expect(begun).toMatchObject({ ordinal: 1, state: "INTENT", previousChecksum: null });
		expect(advanced.previousChecksum).toBe(begun.checksum);
		expect(await readFile(file, "utf8")).toBe(`${canonicalJson(begun)}\n${canonicalJson(advanced)}\n`);
	});

	it("两个 ordinal 共用按物理追加顺序形成的全局 hash chain", async () => {
		const { journal } = await journalFixture();
		const first = await journal.begin(intent());
		const second = await journal.begin(intent("b.txt", {
			sourceArtifact: ".b.txt.pi-undo-source",
			targetArtifact: ".b.txt.pi-undo-target",
		}));
		const firstAdvanced = await journal.advance(1, "SOURCE_QUARANTINED");

		expect(second).toMatchObject({ ordinal: 2, previousChecksum: first.checksum });
		expect(firstAdvanced.previousChecksum).toBe(second.checksum);
	});

	it("begin 忽略 intent 中伪造的保留字段", async () => {
		const { journal, file } = await journalFixture();
		const begun = await journal.begin({
			...intent(),
			schemaVersion: 2,
			opId: "other-operation",
			ordinal: 99,
			state: "CLEANED",
			previousChecksum: "9".repeat(64),
			checksum: "8".repeat(64),
		} as MutationIntent);

		expect(begun).toMatchObject({
			schemaVersion: 1,
			opId: "operation-1",
			ordinal: 1,
			state: "INTENT",
			previousChecksum: null,
		});
		expect(await new MutationJournal(file, "operation-1").load()).toEqual([begun]);
	});

	it("同一实例并发 begin 被串行化为连续 ordinal", async () => {
		const { journal, file } = await journalFixture();
		const [first, second] = await Promise.all([
			journal.begin(intent()),
			journal.begin(intent("b.txt", {
				sourceArtifact: ".b.txt.pi-undo-source",
				targetArtifact: ".b.txt.pi-undo-target",
			})),
		]);

		expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
		expect(await new MutationJournal(file, "operation-1").load()).toEqual([first, second]);
	});

	it("同一 ordinal 并发 advance 只允许一次推进成功，且日志仍可重载", async () => {
		const { journal, file } = await journalFixture();
		await journal.begin(intent());

		const results = await Promise.allSettled([
			journal.advance(1, "SOURCE_QUARANTINED"),
			journal.advance(1, "SOURCE_QUARANTINED"),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		await journal.advance(1, "SOURCE_VERIFIED");
		expect(await new MutationJournal(file, "operation-1").load()).toMatchObject([
			{ ordinal: 1, state: "SOURCE_VERIFIED" },
		]);
	});

	it("拒绝状态跳跃、回退与重复推进", async () => {
		const { journal } = await journalFixture();
		await journal.begin(intent());

		await expect(journal.advance(1, "SOURCE_VERIFIED")).rejects.toThrow("严格推进");
		await journal.advance(1, "SOURCE_QUARANTINED");
		await expect(journal.advance(1, "INTENT")).rejects.toThrow("严格推进");
		await expect(journal.advance(1, "SOURCE_QUARANTINED")).rejects.toThrow("严格推进");
	});

	it("rollback 专用终结允许从任一 active 状态直接进入 CLEANED 并可重载", async () => {
		const activeStates = [
			"INTENT",
			"SOURCE_QUARANTINED",
			"SOURCE_VERIFIED",
			"TARGET_INSTALLED",
			"TARGET_VERIFIED",
		] as const;
		for (const targetState of activeStates) {
			const { journal, file } = await journalFixture();
			await journal.begin(intent());
			for (const state of activeStates.slice(1)) {
				if (stateOrderForTest(state) > stateOrderForTest(targetState)) break;
				await journal.advance(1, state);
			}

			const cleaned = await journal.markRollbackCleaned(1);

			expect(cleaned.state).toBe("CLEANED");
			expect(await new MutationJournal(file, "operation-1").load()).toEqual([cleaned]);
			await expect(journal.assertCleaned()).resolves.toBeUndefined();
		}
	});

	it("rollback 终结拒绝缺失 ordinal、CLEANED 重复调用，普通 advance 仍拒绝跳到 CLEANED", async () => {
		const { journal } = await journalFixture();
		await expect(journal.markRollbackCleaned(1)).rejects.toThrow("rollback");
		await journal.begin(intent());
		await expect(journal.advance(1, "CLEANED")).rejects.toThrow("严格推进");
		await journal.markRollbackCleaned(1);
		await expect(journal.markRollbackCleaned(1)).rejects.toThrow("rollback");
		await expect(journal.advance(1, "SOURCE_QUARANTINED")).rejects.toThrow("严格推进");
	});

	it("拒绝同一 ordinal 的不同 immutable payload", async () => {
		const { journal, file } = await journalFixture();
		const first = record("operation-1", 1, "INTENT", null);
		const conflict = record("operation-1", 1, "SOURCE_QUARANTINED", first.checksum, { path: "other.txt" });
		await writeFile(file, `${canonicalJson(first)}\n${canonicalJson(conflict)}\n`);

		await expect(journal.load()).rejects.toThrow("immutable");
	});

	it("拒绝 hash chain 断裂、错误 opId、非法记录与不连续 ordinal", async () => {
		const cases: MutationRecord[] = [
			record("operation-1", 1, "INTENT", "9".repeat(64)),
			record("other-operation", 1, "INTENT", null),
			record("operation-1", 1, "INTENT", null, { ordinal: 0 }),
			record("operation-1", 2, "INTENT", null),
		];

		for (const invalid of cases) {
			const { journal, file } = await journalFixture();
			await writeFile(file, `${canonicalJson(invalid)}\n`);
			await expect(journal.load()).rejects.toThrow();
		}
	});

	it("忽略 torn JSON 尾记录，且不升级 durable 状态", async () => {
		const { journal, file } = await journalFixture();
		const first = record("operation-1", 1, "INTENT", null);
		await writeFile(file, `${canonicalJson(first)}\n{"schemaVersion":1`);

		expect(await journal.load()).toEqual([first]);
	});

	it("忽略完整但无 LF 的末条记录，且不升级 durable 状态", async () => {
		const { journal, file } = await journalFixture();
		const first = record("operation-1", 1, "INTENT", null);
		const second = record("operation-1", 1, "SOURCE_QUARANTINED", first.checksum);
		await writeFile(file, `${canonicalJson(first)}\n${canonicalJson(second)}`);

		expect(await journal.load()).toEqual([first]);
	});

	it("advance 前移除 torn JSON 尾部，并按 UTF-8 字节位置截断", async () => {
		const { journal, file } = await journalFixture();
		const begun = await journal.begin(intent("目录/中文.txt", {
			sourceArtifact: "目录/.中文.txt.pi-undo-source",
			targetArtifact: "目录/.中文.txt.pi-undo-target",
		}));
		await import("node:fs/promises").then(({ appendFile }) => appendFile(file, '{"残片":"未完成'));

		const advanced = await journal.advance(1, "SOURCE_QUARANTINED");

		expect(await new MutationJournal(file, "operation-1").load()).toEqual([advanced]);
		expect(await readFile(file, "utf8")).toBe(`${canonicalJson(begun)}\n${canonicalJson(advanced)}\n`);
	});

	it("advance 不采信完整但无 LF 的状态，并从 durable INTENT 重新推进", async () => {
		const { journal, file } = await journalFixture();
		const begun = await journal.begin(intent());
		const notDurable = advancedRecord(begun, "SOURCE_QUARANTINED");
		await import("node:fs/promises").then(({ appendFile }) => appendFile(file, canonicalJson(notDurable)));

		const advanced = await journal.advance(1, "SOURCE_QUARANTINED");

		expect(await new MutationJournal(file, "operation-1").load()).toEqual([advanced]);
		expect(await readFile(file, "utf8")).toBe(`${canonicalJson(begun)}\n${canonicalJson(advanced)}\n`);
	});

	it("activeArtifacts 只返回未 CLEANED ordinal 的精确 artifact 集合", async () => {
		const { journal } = await journalFixture();
		await journal.begin(intent());
		await journal.begin(intent("b.txt", {
			kind: "delete",
			sourceArtifact: ".b.txt.pi-undo-source",
			targetArtifact: null,
		}));
		for (const state of ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED", "CLEANED"] as const) {
			await journal.advance(1, state);
		}

		expect(await journal.activeArtifacts()).toEqual(new Set([".b.txt.pi-undo-source"]));
	});

	it("assertCleaned 仅在无记录或全部 CLEANED 时成功", async () => {
		const { journal } = await journalFixture();
		await expect(journal.assertCleaned()).resolves.toBeUndefined();
		await journal.begin(intent());
		await expect(journal.assertCleaned()).rejects.toThrow("未清理");
		for (const state of ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED", "CLEANED"] as const) {
			await journal.advance(1, state);
		}
		await expect(journal.assertCleaned()).resolves.toBeUndefined();
	});

	it("父目录必须先存在，JournalStore 将 mutation journal 接到 transaction 目录", async () => {
		const root = await temporaryRoot();
		const transactionsRoot = join(root, "transactions");
		const store = new JournalStore({ transactionsRoot });
		expect(() => store.mutationJournal("../unsafe")).toThrow("opId 无效");
		await expect(store.mutationJournal("operation-1").begin(intent())).rejects.toMatchObject({ code: "ENOENT" });

		const operation = descriptor(join(root, "session.jsonl"));
		await store.prepare(operation, { planDigest: operation.planDigest });
		await store.mutationJournal(operation.opId).begin(intent());

		const file = join(transactionsRoot, operation.opId, "mutations.jsonl");
		expect(await readFile(file, "utf8")).toMatch(/\n$/);
	});
});

function stateOrderForTest(state: MutationState): number {
	return ["INTENT", "SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"]
		.indexOf(state);
}
