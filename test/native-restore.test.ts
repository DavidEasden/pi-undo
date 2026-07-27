import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDurablePack } from "../src/durable-pack.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { createNativeFileBatch } from "../src/native-restore.ts";
import { recoverPackedMutations } from "../src/packed-recovery.ts";
import { fingerprintBytes } from "../src/quarantine.ts";

const roots: string[] = [];

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-native-restore-")));
	roots.push(root);
	const transaction = join(root, "transaction");
	await mkdir(transaction);
	const source = Buffer.from("source\n");
	const target = Buffer.from("target\n");
	const sourceFingerprint = fingerprintBytes("a.txt", source, 0o644);
	const targetFingerprint = fingerprintBytes("a.txt", target, 0o644);
	const journal = new MutationJournal(join(transaction, "mutations.jsonl"), "operation-1");
	const planDigest = "a".repeat(64);
	const pack = await createDurablePack(journal, {
		opId: journal.operationId,
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
	await writeFile(join(root, "a.txt"), source);
	const native = await createNativeFileBatch({ workspaceRoot: root, planDigest, journal });
	return { root, journal, planDigest, pack, native, source, target };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native restore helper", () => {
	it("成功安装 target 并保留可证明 inode ownership 的 artifacts", async () => {
		const value = await fixture();
		if (value.native === undefined) return;

		await value.native.run(value.pack);
		const original = join(value.root, "a.txt");
		const sourceArtifact = join(value.root, ".pi-undo-q2-11111111111111111111111111111111-source");
		const targetArtifact = join(value.root, ".pi-undo-q2-11111111111111111111111111111111-target");
		expect(await readFile(original)).toEqual(value.target);
		expect(await readFile(sourceArtifact)).toEqual(value.source);
		expect(await readFile(targetArtifact)).toEqual(value.target);
		expect((await lstat(original)).ino).toBe((await lstat(targetArtifact)).ino);
		expect(await value.journal.load()).toEqual([]);

		expect(await recoverPackedMutations({
			workspaceRoot: value.root,
			journal: value.journal,
			planDigest: value.planDigest,
			decision: "rollback",
		})).toEqual({ kind: "clean" });
		expect(await readFile(original)).toEqual(value.source);
	});

	it("spawn 前 pack 被改写时 helper 拒绝 mutation", async () => {
		const value = await fixture();
		if (value.native === undefined) return;
		await writeFile(value.pack.storagePath, Buffer.from("corrupt pack"));

		await expect(value.native.run(value.pack)).rejects.toThrow();
		expect(await readFile(join(value.root, "a.txt"))).toEqual(value.source);
	});

	it("verify-only 不修改 workspace 与 artifacts", async () => {
		const value = await fixture();
		if (value.native === undefined) return;
		expect(await value.native.verifySource(value.pack)).toBe(true);
		expect(await readFile(join(value.root, "a.txt"))).toEqual(value.source);
		await expect(lstat(join(value.root, ".pi-undo-q2-11111111111111111111111111111111-source")))
			.rejects.toMatchObject({ code: "ENOENT" });
	});
});
