import { link, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDurablePack, finalizeDurablePack, loadDurablePack } from "../src/durable-pack.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import {
	cleanupPackedMutations,
	materializePackedMutationJournal,
	recoverPackedMutations,
} from "../src/packed-recovery.ts";
import { fingerprintBytes } from "../src/quarantine.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(live: "source" | "target" | "external") {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-packed-recovery-"));
	roots.push(root);
	const transaction = join(root, "transaction");
	await mkdir(transaction);
	const source = Buffer.from("source\n");
	const target = Buffer.from("target\n");
	const sourceFingerprint = fingerprintBytes("a.txt", source, 0o644);
	const targetFingerprint = fingerprintBytes("a.txt", target, 0o644);
	const journal = new MutationJournal(join(transaction, "mutations.jsonl"), "operation-1");
	const planDigest = "a".repeat(64);
	await createDurablePack(journal, {
		opId: "operation-1",
		planDigest,
		entries: [{
			path: "a.txt",
			sourceArtifact: ".pi-undo-q2-11111111111111111111111111111111-source",
			targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
			sourceFingerprint,
			targetFingerprint,
			variants: [
				{ kind: "file", fingerprint: sourceFingerprint, mode: 0o644, bytes: source },
				{ kind: "file", fingerprint: targetFingerprint, mode: 0o644, bytes: target },
			],
		}],
	});
	const original = join(root, "a.txt");
	const sourceArtifact = join(root, ".pi-undo-q2-11111111111111111111111111111111-source");
	const targetArtifact = join(root, ".pi-undo-q2-11111111111111111111111111111111-target");
	await writeFile(original, live === "source" ? source : live === "target" ? target : "external\n");
	await writeFile(sourceArtifact, source);
	if (live === "target") {
		await link(original, targetArtifact);
	} else {
		await writeFile(targetArtifact, target);
	}
	return { root, journal, planDigest, source, target };
}

describe("packed mutation recovery", () => {
	it("pack durable 但 mutation 尚未开始时 rollback 幂等收敛", async () => {
		const fixtureValue = await fixture("source");
		await unlink(join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-source"));
		await unlink(join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-target"));

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "clean" });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.source);
		expect(await fixtureValue.journal.assertCleaned()).toBeUndefined();
	});

	it("durable INTENT 前缀从 pack 补齐后再恢复全部路径", async () => {
		const fixtureValue = await fixture("target");
		const sourceFingerprintA = fingerprintBytes("a.txt", fixtureValue.source, 0o644);
		const targetFingerprintA = fingerprintBytes("a.txt", fixtureValue.target, 0o644);
		const sourceB = Buffer.from("source-b\n");
		const targetB = Buffer.from("target-b\n");
		const sourceFingerprintB = fingerprintBytes("b.txt", sourceB, 0o644);
		const targetFingerprintB = fingerprintBytes("b.txt", targetB, 0o644);
		await createDurablePack(fixtureValue.journal, {
			opId: fixtureValue.journal.operationId,
			planDigest: fixtureValue.planDigest,
			entries: [
				{
					path: "a.txt",
					sourceArtifact: ".pi-undo-q2-11111111111111111111111111111111-source",
					targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
					sourceFingerprint: sourceFingerprintA,
					targetFingerprint: targetFingerprintA,
					variants: [
						{ kind: "file", fingerprint: sourceFingerprintA, mode: 0o644, bytes: fixtureValue.source },
						{ kind: "file", fingerprint: targetFingerprintA, mode: 0o644, bytes: fixtureValue.target },
					],
				},
				{
					path: "b.txt",
					sourceArtifact: ".pi-undo-q2-22222222222222222222222222222222-source",
					targetArtifact: ".pi-undo-q2-22222222222222222222222222222222-target",
					sourceFingerprint: sourceFingerprintB,
					targetFingerprint: targetFingerprintB,
					variants: [
						{ kind: "file", fingerprint: sourceFingerprintB, mode: 0o644, bytes: sourceB },
						{ kind: "file", fingerprint: targetFingerprintB, mode: 0o644, bytes: targetB },
					],
				},
			],
		});
		await writeFile(join(fixtureValue.root, ".pi-undo-q2-22222222222222222222222222222222-source"), sourceB);
		await writeFile(join(fixtureValue.root, "b.txt"), targetB);
		await link(
			join(fixtureValue.root, "b.txt"),
			join(fixtureValue.root, ".pi-undo-q2-22222222222222222222222222222222-target"),
		);
		await fixtureValue.journal.beginMany([{
			kind: "write",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q2-11111111111111111111111111111111-source",
			targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
			sourceFingerprint: sourceFingerprintA,
			targetFingerprint: targetFingerprintA,
		}]);

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
			retainArtifacts: true,
		})).toEqual({ kind: "clean" });
		expect((await fixtureValue.journal.load()).map((record) => [record.path, record.state])).toEqual([
			["a.txt", "TARGET_VERIFIED"],
			["b.txt", "TARGET_VERIFIED"],
		]);
	});

	it("WAL immutable payload 与 pack 不匹配时 fail closed", async () => {
		const fixtureValue = await fixture("target");
		await fixtureValue.journal.beginMany([{
			kind: "write",
			path: "a.txt",
			sourceArtifact: ".pi-undo-q2-33333333333333333333333333333333-source",
			targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
			sourceFingerprint: fingerprintBytes("a.txt", fixtureValue.source, 0o644),
			targetFingerprint: fingerprintBytes("a.txt", fixtureValue.target, 0o644),
		}]);

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "conflict", paths: 1 });
		expect((await fixtureValue.journal.load())[0]?.state).toBe("INTENT");
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.target);
	});

	it("WAL records 超出 pack 路径数量时 fail closed", async () => {
		const fixtureValue = await fixture("target");
		const sourceFingerprint = fingerprintBytes("a.txt", fixtureValue.source, 0o644);
		const targetFingerprint = fingerprintBytes("a.txt", fixtureValue.target, 0o644);
		await fixtureValue.journal.beginMany([
			{
				kind: "write",
				path: "a.txt",
				sourceArtifact: ".pi-undo-q2-11111111111111111111111111111111-source",
				targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
				sourceFingerprint,
				targetFingerprint,
			},
			{
				kind: "write",
				path: "b.txt",
				sourceArtifact: ".pi-undo-q2-22222222222222222222222222222222-source",
				targetArtifact: ".pi-undo-q2-22222222222222222222222222222222-target",
				sourceFingerprint: fingerprintBytes("b.txt", fixtureValue.source, 0o644),
				targetFingerprint: fingerprintBytes("b.txt", fixtureValue.target, 0o644),
			},
		]);

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "conflict", paths: 2 });
		expect((await fixtureValue.journal.load()).every((record) => record.state === "INTENT")).toBe(true);
	});

	it("source 已隔离且 target 未安装时 rollback 从 pack 恢复", async () => {
		const fixtureValue = await fixture("source");
		await unlink(join(fixtureValue.root, "a.txt"));

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "clean" });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.source);
	});

	it("target 已安装但 ownership marker 尚未建立时 fail closed", async () => {
		const fixtureValue = await fixture("target");
		await unlink(join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-target"));

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "conflict", paths: 1 });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.target);
		expect(await readFile(join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-source")))
			.toEqual(fixtureValue.source);
	});

	it("cursor 前从仅剩 INTENT 的 native success 现场恢复 source", async () => {
		const fixtureValue = await fixture("target");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "clean" });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.source);
		expect(await fixtureValue.journal.assertCleaned()).toBeUndefined();
	});

	it("cursor 后从仅剩 INTENT 的 native success 现场保持 target", async () => {
		const fixtureValue = await fixture("target");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
		})).toEqual({ kind: "clean" });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.target);
		expect(await fixtureValue.journal.assertCleaned()).toBeUndefined();
	});

	it("未知 external original 保持原样并返回 conflict", async () => {
		const fixtureValue = await fixture("external");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "conflict", paths: 1 });
		expect(await readFile(join(fixtureValue.root, "a.txt"), "utf8")).toBe("external\n");
		expect((await fixtureValue.journal.load())[0]?.state).toBe("INTENT");
	});

	it("同 fingerprint 不同 inode 的 external replacement 不被 rollback 覆盖", async () => {
		const fixtureValue = await fixture("target");
		const original = join(fixtureValue.root, "a.txt");
		const targetArtifact = join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-target");
		const ownedInode = (await lstat(targetArtifact)).ino;
		await unlink(original);
		await writeFile(original, fixtureValue.target);
		expect((await lstat(original)).ino).not.toBe(ownedInode);

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "conflict", paths: 1 });
		expect(await readFile(original)).toEqual(fixtureValue.target);
		expect(await readFile(targetArtifact)).toEqual(fixtureValue.target);
		expect((await fixtureValue.journal.load())[0]?.state).toBe("INTENT");
	});

	it("roll-forward 先保留 ownership 到 durable fsync，再补 CLEANED", async () => {
		const fixtureValue = await fixture("target");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
			retainArtifacts: true,
		})).toEqual({ kind: "clean" });
		expect((await fixtureValue.journal.load())[0]?.state).toBe("TARGET_VERIFIED");
		expect(await readFile(join(fixtureValue.root, ".pi-undo-q2-11111111111111111111111111111111-source")))
			.toEqual(fixtureValue.source);

		await finalizeDurablePack(fixtureValue.journal, fixtureValue.root);
		await cleanupPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
		});
		expect(await fixtureValue.journal.assertCleaned()).toBeUndefined();
		const states = (await readFile(fixtureValue.journal.storagePath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => (JSON.parse(line) as { state: string }).state);
		expect(states).toEqual([
			"INTENT",
			"SOURCE_QUARANTINED",
			"SOURCE_VERIFIED",
			"TARGET_INSTALLED",
			"TARGET_VERIFIED",
			"CLEANED",
		]);
	});

	it("native success 快路径并行 materialize WAL 与 fsync 后保留完整状态链", async () => {
		const fixtureValue = await fixture("target");
		const pack = await loadDurablePack(fixtureValue.journal, fixtureValue.planDigest, true);

		await Promise.all([
			materializePackedMutationJournal(fixtureValue.journal, pack),
			finalizeDurablePack(fixtureValue.journal, fixtureValue.root, {
				allowCleanedOwnershipWithoutMarker: false,
			}),
		]);
		expect((await fixtureValue.journal.load())[0]?.state).toBe("TARGET_VERIFIED");
		await cleanupPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
		});

		const states = (await readFile(fixtureValue.journal.storagePath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => (JSON.parse(line) as { state: string }).state);
		expect(states).toEqual([
			"INTENT",
			"SOURCE_QUARANTINED",
			"SOURCE_VERIFIED",
			"TARGET_INSTALLED",
			"TARGET_VERIFIED",
			"CLEANED",
		]);
	});

	it("native success 快路径仍拒绝同 fingerprint 不同 inode 的 external replacement", async () => {
		const fixtureValue = await fixture("target");
		const pack = await loadDurablePack(fixtureValue.journal, fixtureValue.planDigest, true);
		await materializePackedMutationJournal(fixtureValue.journal, pack);
		const original = join(fixtureValue.root, "a.txt");
		await unlink(original);
		await writeFile(original, fixtureValue.target);

		await expect(finalizeDurablePack(fixtureValue.journal, fixtureValue.root))
			.rejects.toThrow("target ownership 冲突");
		expect((await fixtureValue.journal.load())[0]?.state).toBe("TARGET_VERIFIED");
		expect(await readFile(join(
			fixtureValue.root,
			".pi-undo-q2-11111111111111111111111111111111-source",
		))).toEqual(fixtureValue.source);
	});

	it("CLEANED 后 ownership marker 已清理仍可完成 cursor-after finalization", async () => {
		const fixtureValue = await fixture("target");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
		})).toEqual({ kind: "clean" });

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
			retainArtifacts: true,
		})).toEqual({ kind: "clean" });
		await finalizeDurablePack(fixtureValue.journal, fixtureValue.root);
		await cleanupPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
		});
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.target);
	});

	it("CLEANED 后 target 丢失仍可按 durable cursor 从 pack 重建", async () => {
		const fixtureValue = await fixture("target");
		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
		})).toEqual({ kind: "clean" });
		await unlink(join(fixtureValue.root, "a.txt"));

		expect(await recoverPackedMutations({
			workspaceRoot: fixtureValue.root,
			journal: fixtureValue.journal,
			planDigest: fixtureValue.planDigest,
			decision: "roll_forward",
		})).toEqual({ kind: "clean" });
		expect(await readFile(join(fixtureValue.root, "a.txt"))).toEqual(fixtureValue.target);
		expect(await fixtureValue.journal.assertCleaned()).toBeUndefined();
	});
});
