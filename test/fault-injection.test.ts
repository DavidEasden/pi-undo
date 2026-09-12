import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, checksum } from "../src/encoding.ts";
import type { PendingJournal } from "../src/journal.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import type { JournalState, ManifestId, OperationDescriptor, SessionFileIdentity, SnapshotManifest } from "../src/model.ts";
import {
	QuarantineManager,
	fingerprintBytes,
	fingerprintFile,
} from "../src/quarantine.ts";
import { JournalRecovery } from "../src/recovery.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity: SessionFileIdentity = {
	path: "/sessions/session.jsonl",
	headerChecksum: "a".repeat(64),
};

function manifest(seed: string): SnapshotManifest {
	return {
		schemaVersion: 1,
		manifestId: seed.repeat(64) as ManifestId,
		workspaceIdentity: "/workspace",
		topologyFingerprint: "f".repeat(64),
		coverage: "complete",
		roots: [],
		createdAt: "2026-07-25T00:00:00.000Z",
	};
}

interface PendingOptions {
	readonly sessionIdentity?: SessionFileIdentity;
	readonly workspaceIdentity?: string;
}

function pending(scopePaths: readonly string[] = ["file.txt"], options: PendingOptions = {}): PendingJournal {
	const descriptorPayload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		sessionIdentity: options.sessionIdentity ?? identity,
		workspaceIdentity: options.workspaceIdentity ?? "/workspace",
		action: "undo" as const,
		fromLogicalLeaf: "after",
		toLogicalLeaf: "before",
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: "b".repeat(64) as ManifestId,
		coverage: `paths:${checksum(canonicalJson(scopePaths))}`,
		scopePaths: [...scopePaths],
		planDigest: "d".repeat(64),
	};
	const descriptor: OperationDescriptor = {
		...descriptorPayload,
		checksum: checksum(canonicalJson(descriptorPayload)),
	};
	const statePayload = {
		schemaVersion: 1 as const,
		opId: descriptor.opId,
		phase: "APPLYING" as const,
		revision: 4,
		descriptorChecksum: descriptor.checksum,
		observedLogicalLeaf: "before",
	};
	const state: JournalState = { ...statePayload, checksum: checksum(canonicalJson(statePayload)) };
	return {
		descriptor,
		plan: { planDigest: descriptor.planDigest },
		state,
	};
}

interface FixtureOptions extends PendingOptions {
	readonly assessForeignTransaction?: (journal: PendingJournal) => Promise<boolean>;
	readonly assessCompensatedTransaction?: (journal: PendingJournal) => Promise<boolean>;
	readonly failingSettle?: boolean;
}

function fixture(
	marker: "absent" | "match" | "conflict",
	leaf: string | null,
	mutationResult: "clean" | "conflict" = "clean",
	scopePaths: readonly string[] = ["file.txt"],
	options: FixtureOptions = {},
) {
	let journals: PendingJournal[] = [pending(scopePaths, options)];
	const calls: string[] = [];
	const recovery = new JournalRecovery({
		sessionIdentity: identity,
		workspaceIdentity: "/workspace",
		...(options.assessForeignTransaction === undefined
			? {}
			: { assessForeignTransaction: options.assessForeignTransaction }),
		...(options.assessCompensatedTransaction === undefined
			? {}
			: { assessCompensatedTransaction: options.assessCompensatedTransaction }),
		getLogicalLeafId: () => leaf,
		loadPending: async () => journals,
		inspectCursor: async () => marker === "match"
			? { kind: "match", needsTrailingNewline: true }
			: { kind: marker },
		finalizeCursor: async () => { calls.push("cursor-finalized"); },
		recoverMutations: async (_journal, decision) => {
			calls.push(`mutations:${decision}`);
			return mutationResult === "clean" ? { kind: "clean" } : { kind: "conflict", paths: 1 };
		},
		capture: async () => { calls.push("capture"); return manifest("c"); },
		loadManifest: async (id) => {
			calls.push(`load:${id[0]}`);
			return id === "a".repeat(64) ? manifest("a") : manifest("b");
		},
		planRestore: async (current, target) => {
			calls.push(`plan:${target.manifestId[0]}`);
			return {
				currentManifestId: current.manifestId,
				targetManifestId: target.manifestId,
				boundaryRoots: ["."],
				deletePaths: [],
				writePaths: ["file.txt"],
				planDigest: "e".repeat(64),
			};
		},
		applyRestore: async (_plan, target) => {
			calls.push(`restore:${target.manifestId[0]}`);
			return { code: "ok", verifiedPaths: 1, totalPaths: 1 };
		},
		settle: async (_opId, phase) => {
			if (options.failingSettle === true) throw new Error("注入 settle 失败");
			calls.push(`settle:${phase}`);
			journals = [];
		},
	});
	return { recovery, calls };
}

describe("JournalRecovery fault injection", () => {
	it("没有 cursor marker 时幂等恢复 rollback manifest 并终止 journal", async () => {
		const { recovery, calls } = fixture("absent", "after");

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual(["mutations:rollback", "capture", "load:b", "plan:b", "restore:b", "settle:ABORTED"]);
		expect(await recovery.recover()).toEqual({ kind: "clean", operations: 0 });
	});

	it("存在可信 cursor marker 时补完 target manifest 和 marker durability", async () => {
		const { recovery, calls } = fixture("match", "before");

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual([
			"mutations:roll_forward", "capture", "load:a", "plan:a", "restore:a", "cursor-finalized", "settle:COMMITTED",
		]);
	});

	it("空 scope rollback recovery 在 mutation 收敛后不访问 workspace", async () => {
		const { recovery, calls } = fixture("absent", "after", "clean", []);

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual(["mutations:rollback", "settle:ABORTED"]);
	});

	it("空 scope roll-forward recovery 不访问 workspace 但补完 cursor", async () => {
		const { recovery, calls } = fixture("match", "before", "clean", []);

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual(["mutations:roll_forward", "cursor-finalized", "settle:COMMITTED"]);
	});

	it("mutation 现场冲突时在 capture 前锁定", async () => {
		const { recovery, calls } = fixture("absent", "after", "conflict");

		expect(await recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "mutation_conflict",
			files: 1,
			opId: "operation-1",
		});
		expect(calls).toEqual(["mutations:rollback"]);
	});

	it("cursor 冲突时 fail closed，不触碰工作区", async () => {
		const { recovery, calls } = fixture("conflict", "before");

		expect(await recovery.recover()).toMatchObject({ kind: "locked", reason: "cursor_conflict" });
		expect(calls).toEqual([]);
	});

	it("session logical leaf 与 marker 决策不一致时 fail closed", async () => {
		const { recovery, calls } = fixture("absent", "before");

		expect(await recovery.recover()).toMatchObject({ kind: "locked", reason: "session_leaf_mismatch" });
		expect(calls).toEqual([]);
	});

	it("严格证明 foreign session-only transaction 时跳过且不触碰 mutation 或 workspace", async () => {
		let assessed = 0;
		const { recovery, calls } = fixture("absent", "after", "clean", [], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessForeignTransaction: async () => {
				assessed += 1;
				return true;
			},
		});

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 0 });
		expect(assessed).toBe(1);
		expect(calls).toEqual([]);
	});

	it("foreign identity 证据不足或 workspace 不匹配时保持 recovery lock", async () => {
		const foreign = { ...identity, path: "/sessions/old-session.jsonl" };
		const rejected = fixture("absent", "after", "clean", [], {
			sessionIdentity: foreign,
			assessForeignTransaction: async () => false,
		});
		expect(await rejected.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(rejected.calls).toEqual([]);

		const failed = fixture("absent", "after", "clean", [], {
			sessionIdentity: foreign,
			assessForeignTransaction: async () => { throw new Error("assessment failed"); },
		});
		expect(await failed.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(failed.calls).toEqual([]);

		let assessed = false;
		const wrongWorkspace = fixture("absent", "after", "clean", [], {
			workspaceIdentity: "/other-workspace",
			assessForeignTransaction: async () => {
				assessed = true;
				return true;
			},
		});
		expect(await wrongWorkspace.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "workspace_identity_mismatch",
		});
		expect(assessed).toBe(false);
		expect(wrongWorkspace.calls).toEqual([]);
	});

	it("完全补偿的 foreign transaction 直接 settle 为 ABORTED，不触碰 workspace", async () => {
		const { recovery, calls } = fixture("absent", "after", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => true,
		});

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual(["settle:ABORTED"]);
	});

	it("完全补偿的 foreign transaction 遇到可信 cursor marker 或冲突时 fail closed", async () => {
		const matched = fixture("match", "before", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => true,
		});
		expect(await matched.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(matched.calls).toEqual([]);

		const conflicted = fixture("conflict", "before", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => true,
		});
		expect(await conflicted.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(conflicted.calls).toEqual([]);
	});

	it("补偿评估失败或 settle 失败时保持 recovery lock", async () => {
		const rejected = fixture("absent", "after", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => false,
		});
		expect(await rejected.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(rejected.calls).toEqual([]);

		const thrown = fixture("absent", "after", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => {
				throw new Error("注入评估失败");
			},
		});
		expect(await thrown.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(thrown.calls).toEqual([]);

		const failed = fixture("absent", "after", "clean", ["file.txt"], {
			sessionIdentity: { ...identity, path: "/sessions/old-session.jsonl" },
			assessCompensatedTransaction: async () => true,
			failingSettle: true,
		});
		expect(await failed.recovery.recover()).toMatchObject({
			kind: "locked",
			reason: "session_identity_mismatch",
		});
		expect(failed.calls).toEqual([]);
	});
});

describe("Quarantine mutation 真实现场恢复", () => {
	async function crashFixture(state: "INTENT" | "SOURCE_QUARANTINED" | "SOURCE_VERIFIED" | "TARGET_INSTALLED" | "TARGET_VERIFIED") {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-recovery-"));
		temporaryRoots.push(root);
		const path = "file.txt";
		const original = join(root, path);
		const sourceBytes = Buffer.from("source\n");
		const targetBytes = Buffer.from("target\n");
		await writeFile(original, sourceBytes, { mode: 0o644 });
		const journal = new MutationJournal(join(root, "mutations.jsonl"), "operation-1");
		const sourceArtifact = ".pi-undo-q1-11111111111111111111111111111111-source";
		const targetArtifact = ".pi-undo-q1-11111111111111111111111111111111-target";
		const record = await journal.begin({
			kind: "write",
			path,
			sourceArtifact,
			targetArtifact,
			sourceFingerprint: await fingerprintFile(original, path),
			targetFingerprint: fingerprintBytes(path, targetBytes, 0o644),
		});
		if (state !== "INTENT") {
			await writeFile(join(root, targetArtifact), targetBytes, { mode: 0o644 });
			await link(original, join(root, sourceArtifact));
			await unlink(original);
			await journal.advance(record.ordinal, "SOURCE_QUARANTINED");
		}
		if (state === "SOURCE_VERIFIED" || state === "TARGET_INSTALLED" || state === "TARGET_VERIFIED") {
			await journal.advance(record.ordinal, "SOURCE_VERIFIED");
		}
		if (state === "TARGET_INSTALLED" || state === "TARGET_VERIFIED") {
			await link(join(root, targetArtifact), original);
			await journal.advance(record.ordinal, "TARGET_INSTALLED");
		}
		if (state === "TARGET_VERIFIED") {
			await unlink(join(root, targetArtifact));
			await journal.advance(record.ordinal, "TARGET_VERIFIED");
		}
		return { root, path, original, journal, manager: new QuarantineManager({ workspaceRoot: root, journal }) };
	}

	it.each([
		["INTENT", "rollback"],
		["SOURCE_QUARANTINED", "rollback"],
		["SOURCE_VERIFIED", "rollback"],
		["TARGET_INSTALLED", "roll_forward"],
		["TARGET_VERIFIED", "roll_forward"],
	] as const)("%s 状态按 %s 收敛并可重复启动", async (state, decision) => {
		const fixture = await crashFixture(state);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const active = (await fixture.journal.load()).filter((record) => record.state !== "CLEANED");
			for (const record of decision === "rollback" ? active.reverse() : active) {
				if (decision === "rollback") await fixture.manager.restoreMutation(record);
				else {
					await fixture.manager.rollForwardMutation(record);
					const [latest] = await fixture.journal.load();
					await fixture.manager.cleanupMutation(latest!);
				}
			}
		}

		expect(await readFile(fixture.original, "utf8")).toBe(decision === "rollback" ? "source\n" : "target\n");
		expect(await fixture.manager.inspectArtifacts()).toEqual([]);
		await expect(fixture.journal.assertCleaned()).resolves.toBeUndefined();
	});

	it("original 出现未知外部内容时保留所有版本并拒绝恢复", async () => {
		const fixture = await crashFixture("SOURCE_QUARANTINED");
		await writeFile(fixture.original, "external\n");
		const [record] = await fixture.journal.load();

		await expect(fixture.manager.restoreMutation(record!)).rejects.toThrow("外部并发");

		expect(await readFile(fixture.original, "utf8")).toBe("external\n");
		expect((await fixture.manager.inspectArtifacts()).map((artifact) => artifact.role).sort()).toEqual(["source", "target"]);
		await expect(lstat(join(fixture.root, record!.sourceArtifact))).resolves.toBeDefined();
	});
});
