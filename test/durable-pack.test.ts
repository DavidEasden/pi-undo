import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createDurablePack,
	durablePackPath,
	loadDurablePack,
} from "../src/durable-pack.ts";
import { checksum } from "../src/encoding.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { fingerprintAbsent, fingerprintBytes, fingerprintSymlink } from "../src/quarantine.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; journal: MutationJournal }> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-pack-"));
	roots.push(root);
	await mkdir(join(root, "transaction"));
	return {
		root,
		journal: new MutationJournal(join(root, "transaction", "mutations.jsonl"), "operation-1"),
	};
}

describe("DurablePack", () => {
	it("单文件 durable pack 绑定 operation、plan、path、fingerprint 与 bytes", async () => {
		const { journal } = await fixture();
		const planDigest = "a".repeat(64);
		const absent = fingerprintAbsent("a.txt");
		const fileFingerprint = fingerprintBytes("a.txt", Buffer.from("target\n"), 0o644);
		const symlinkFingerprint = fingerprintSymlink("link", "a.txt");
		await createDurablePack(journal, {
			opId: "operation-1",
			planDigest,
			entries: [
				{
					path: "a.txt",
					sourceArtifact: ".pi-undo-q2-11111111111111111111111111111111-source",
					targetArtifact: ".pi-undo-q2-11111111111111111111111111111111-target",
					sourceFingerprint: absent,
					targetFingerprint: fileFingerprint,
					variants: [
						{ kind: "absent", fingerprint: absent },
						{ kind: "file", fingerprint: fileFingerprint, mode: 0o644, bytes: Buffer.from("target\n") },
					],
				},
				{
					path: "link",
					sourceArtifact: ".pi-undo-q2-22222222222222222222222222222222-source",
					targetArtifact: null,
					sourceFingerprint: symlinkFingerprint,
					targetFingerprint: symlinkFingerprint,
					variants: [{ kind: "symlink", fingerprint: symlinkFingerprint, linkText: "a.txt" }],
				},
			],
		});

		const loaded = await loadDurablePack(journal, planDigest);
		expect(loaded.paths()).toEqual(["a.txt", "link"]);
		expect(loaded.targetFingerprint("a.txt")).toBe(fileFingerprint);
		expect(loaded.leaf("a.txt", absent)).toEqual({ kind: "absent", fingerprint: absent });
		expect(loaded.leaf("a.txt", fileFingerprint)).toMatchObject({
			kind: "file",
			fingerprint: fileFingerprint,
			mode: 0o644,
			bytes: new Uint8Array(Buffer.from("target\n")),
		});
		expect(loaded.leaf("link", symlinkFingerprint)).toEqual({
			kind: "symlink",
			fingerprint: symlinkFingerprint,
			linkText: "a.txt",
		});
	});

	it("payload 或 planDigest 被篡改时拒绝启用 pack", async () => {
		const { journal } = await fixture();
		const planDigest = "e".repeat(64);
		const fingerprint = fingerprintBytes("a.txt", Buffer.from("bytes"), 0o644);
		await createDurablePack(journal, {
			opId: "operation-1",
			planDigest,
			entries: [{
				path: "a.txt",
				sourceArtifact: ".pi-undo-q2-33333333333333333333333333333333-source",
				targetArtifact: ".pi-undo-q2-33333333333333333333333333333333-target",
				sourceFingerprint: fingerprint,
				targetFingerprint: fingerprint,
				variants: [{ kind: "file", fingerprint, mode: 0o644, bytes: Buffer.from("bytes") }],
			}],
		});
		await expect(loadDurablePack(journal, "0".repeat(64))).rejects.toThrow("planDigest");

		const path = durablePackPath(journal);
		const bytes = await readFile(path);
		bytes[bytes.length - 1] ^= 0xff;
		await writeFile(path, bytes);
		await expect(loadDurablePack(journal, planDigest)).rejects.toThrow("payload checksum");
	});

	it("拒绝重复路径、重复 fingerprint 与缺失 target variant", async () => {
		const { journal } = await fixture();
		const fingerprint = checksum("target");
		const absent = fingerprintAbsent("a.txt");
		await expect(createDurablePack(journal, {
			opId: "operation-1",
			planDigest: "1".repeat(64),
			entries: [{
				path: "a.txt",
				sourceArtifact: ".pi-undo-q2-44444444444444444444444444444444-source",
				targetArtifact: ".pi-undo-q2-44444444444444444444444444444444-target",
				sourceFingerprint: absent,
				targetFingerprint: fingerprint,
				variants: [{ kind: "absent", fingerprint: absent }],
			}],
		})).rejects.toThrow("缺少 target variant");
	});
});
