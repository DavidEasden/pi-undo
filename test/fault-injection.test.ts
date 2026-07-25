import { describe, expect, it } from "vitest";

import { canonicalJson, checksum } from "../src/encoding.ts";
import type { PendingJournal } from "../src/journal.ts";
import type { JournalState, ManifestId, OperationDescriptor, SessionFileIdentity, SnapshotManifest } from "../src/model.ts";
import { JournalRecovery } from "../src/recovery.ts";

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

function pending(): PendingJournal {
	const descriptorPayload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		sessionIdentity: identity,
		workspaceIdentity: "/workspace",
		action: "undo" as const,
		fromLogicalLeaf: "after",
		toLogicalLeaf: "before",
		targetManifestId: "a".repeat(64) as ManifestId,
		rollbackManifestId: "b".repeat(64) as ManifestId,
		coverage: `paths:${checksum(canonicalJson(["file.txt"]))}`,
		scopePaths: ["file.txt"],
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

function fixture(marker: "absent" | "match" | "conflict", leaf: string | null) {
	let journals: PendingJournal[] = [pending()];
	const calls: string[] = [];
	const recovery = new JournalRecovery({
		sessionIdentity: identity,
		workspaceIdentity: "/workspace",
		getLogicalLeafId: () => leaf,
		loadPending: async () => journals,
		inspectCursor: async () => marker === "match"
			? { kind: "match", needsTrailingNewline: true }
			: { kind: marker },
		finalizeCursor: async () => { calls.push("cursor-finalized"); },
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
		expect(calls).toEqual(["capture", "load:b", "plan:b", "restore:b", "settle:ABORTED"]);
		expect(await recovery.recover()).toEqual({ kind: "clean", operations: 0 });
	});

	it("存在可信 cursor marker 时补完 target manifest 和 marker durability", async () => {
		const { recovery, calls } = fixture("match", "before");

		expect(await recovery.recover()).toEqual({ kind: "recovered", operations: 1 });
		expect(calls).toEqual([
			"capture", "load:a", "plan:a", "restore:a", "cursor-finalized", "settle:COMMITTED",
		]);
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
});
