import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDurablePack } from "../src/durable-pack.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { createNativeFileBatch, nativeRestoreCapability } from "../src/native-restore.ts";
import { createOperationScope, runWithOperationContext } from "../src/operation-context.ts";
import { recoverPackedMutations } from "../src/packed-recovery.ts";
import { fingerprintAbsent, fingerprintBytes } from "../src/quarantine.ts";

const roots: string[] = [];

async function hangingHelper(marker: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-native-hang-"));
	roots.push(root);
	const path = join(root, "helper");
	await writeFile(path, `#!/bin/sh\n(sleep 0.3; touch "${marker}") >/dev/null 2>&1 &\nsleep 30\n`);
	await chmod(path, 0o755);
	return path;
}

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

async function mixedFixture() {
	const value = await fixture();
	await mkdir(join(value.root, "src"));
	const paths = ["src/changed.txt", "src/removed.txt", "src/added.txt"];
	const pack = await createDurablePack(value.journal, {
		opId: value.journal.operationId,
		planDigest: value.planDigest,
		entries: paths.map((path, index) => {
			const sourceFingerprint = index === 2 ? fingerprintAbsent(path) : fingerprintBytes(path, value.source, 0o644);
			const targetFingerprint = index === 1 ? fingerprintAbsent(path) : fingerprintBytes(path, value.target, 0o644);
			const nonce = (index + 2).toString().repeat(32);
			return {
				path,
				sourceArtifact: `src/.pi-undo-q2-${nonce}-source`,
				targetArtifact: index === 1 ? null : `src/.pi-undo-q2-${nonce}-target`,
				sourceFingerprint,
				targetFingerprint,
				variants: [
					index === 2 ? { kind: "absent" as const, fingerprint: sourceFingerprint }
						: { kind: "file" as const, fingerprint: sourceFingerprint, mode: 0o644 as const, bytes: value.source },
					index === 1 ? { kind: "absent" as const, fingerprint: targetFingerprint }
						: { kind: "file" as const, fingerprint: targetFingerprint, mode: 0o644 as const, bytes: value.target },
				],
			};
		}),
	});
	for (const path of paths.slice(0, 2)) await writeFile(join(value.root, path), value.source);
	const native = await createNativeFileBatch({
		workspaceRoot: value.root, planDigest: value.planDigest, journal: value.journal,
		requiredCapability: nativeRestoreCapability(pack),
	});
	return { ...value, pack, native, paths };
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

	it("delete-only native batch 原子隔离 source 并可 roll-forward 清理", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-native-delete-")));
		roots.push(root);
		const transaction = join(root, "transaction");
		await mkdir(transaction);
		const source = Buffer.from("source\n");
		const sourceFingerprint = fingerprintBytes("a.txt", source, 0o644);
		const targetFingerprint = fingerprintAbsent("a.txt");
		const journal = new MutationJournal(join(transaction, "mutations.jsonl"), "operation-delete");
		const planDigest = "b".repeat(64);
		const pack = await createDurablePack(journal, {
			opId: journal.operationId,
			planDigest,
			entries: [{
				path: "a.txt",
				sourceArtifact: ".pi-undo-q2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source",
				targetArtifact: null,
				sourceFingerprint,
				targetFingerprint,
				variants: [
					{ kind: "file", fingerprint: sourceFingerprint, mode: 0o644, bytes: source },
					{ kind: "absent", fingerprint: targetFingerprint },
				],
			}],
		});
		await writeFile(join(root, "a.txt"), source);
		const native = await createNativeFileBatch({ workspaceRoot: root, planDigest, journal });
		if (native === undefined) return;

		await native.run(pack);
		expect(await lstat(join(root, "a.txt")).catch(() => undefined)).toBeUndefined();
		expect(await readFile(join(root, ".pi-undo-q2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source")))
			.toEqual(source);
		await expect(recoverPackedMutations({
			workspaceRoot: root,
			journal,
			planDigest,
			decision: "roll_forward",
		})).resolves.toEqual({ kind: "clean" });
		await expect(lstat(join(root, ".pi-undo-q2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source")))
			.rejects.toMatchObject({ code: "ENOENT" });
	});

	it.for(["rollback", "roll_forward"] as const)("子目录混合写入、创建和删除后支持 %s", async (decision, context) => {
		const value = await mixedFixture();
		if (value.native === undefined) return context.skip();
		expect(await value.native.verifySource(value.pack)).toBe(true);
		await value.native.run(value.pack);
		expect(await readFile(join(value.root, value.paths[0]))).toEqual(value.target);
		await expect(lstat(join(value.root, value.paths[1]))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(value.root, value.paths[2]))).toEqual(value.target);
		await expect(recoverPackedMutations({
			workspaceRoot: value.root, journal: value.journal, planDigest: value.planDigest, decision,
		})).resolves.toEqual({ kind: "clean" });
		if (decision === "rollback") {
			for (const path of value.paths.slice(0, 2)) expect(await readFile(join(value.root, path))).toEqual(value.source);
			await expect(lstat(join(value.root, value.paths[2]))).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect((await readdir(join(value.root, "src"))).some((name) => name.startsWith(".pi-undo-q2-"))).toBe(false);
	});

	it("混合计划的父目录被替换为 symlink 时拒绝所有 mutation", async (context) => {
		const value = await mixedFixture();
		if (value.native === undefined) return context.skip();
		await rename(join(value.root, "src"), join(value.root, "moved"));
		await symlink(join(value.root, "moved"), join(value.root, "src"));
		await expect(value.native.run(value.pack)).rejects.toThrow("父目录");
		expect((await readdir(join(value.root, "moved"))).sort()).toEqual(["changed.txt", "removed.txt"]);
		for (const name of ["changed.txt", "removed.txt"]) expect(await readFile(join(value.root, "moved", name))).toEqual(value.source);
	});

	it("混合计划部分隔离失败时可从 pack 回滚并保留外来文件", async (context) => {
		const value = await mixedFixture();
		if (value.native === undefined) return context.skip();
		await writeFile(join(value.root, "src/added.txt"), "foreign");
		await expect(value.native.run(value.pack)).rejects.toThrow();
		const result = await recoverPackedMutations({
			workspaceRoot: value.root, journal: value.journal, planDigest: value.planDigest, decision: "rollback",
		});
		// 冲突必须保留，恢复器不能把外来内容误认成本次安装结果。
		expect(result.kind).not.toBe("clean");
		expect(await readFile(join(value.root, "src/added.txt"), "utf8")).toBe("foreign");
	});

	it("旧 helper 缺少扩展能力时在 restore 请求写出前回退", async (context) => {
		if (process.platform === "win32" || process.env.PI_UNDO_DISABLE_NATIVE === "1") return context.skip();
		const value = await fixture();
		const executable = join(value.root, "old-helper");
		await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: true, capabilities: ["restore-v1"] }));\n`);
		await chmod(executable, 0o755);
		await expect(createNativeFileBatch({
			workspaceRoot: value.root, journal: value.journal, planDigest: value.planDigest,
			executable, requiredCapability: "restore-files-v2",
		})).resolves.toBeUndefined();
		await expect(lstat(join(dirname(value.journal.storagePath), "native-request-v1.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("context 取消时终止 native helper 进程组，不留下迟到写入", async () => {
		const value = await fixture();
		const marker = join(value.root, "late-write");
		const native = await createNativeFileBatch({
			workspaceRoot: value.root,
			planDigest: value.planDigest,
			journal: value.journal,
			executable: await hangingHelper(marker),
		});
		if (native === undefined) return;
		const scope = createOperationScope();
		const pending = runWithOperationContext(scope.context, () => native.run(value.pack));
		setTimeout(() => scope.cancel(), 50);
		try {
			await expect(pending).rejects.toMatchObject({ code: "operation_cancelled" });
			await new Promise((resolve) => setTimeout(resolve, 500));
			await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			scope.dispose();
		}
	});

	it("已取消的 context 在写出 request 前结束", async () => {
		const value = await fixture();
		const native = await createNativeFileBatch({
			workspaceRoot: value.root,
			planDigest: value.planDigest,
			journal: value.journal,
			executable: await hangingHelper(join(value.root, "late-write")),
		});
		if (native === undefined) return;
		const scope = createOperationScope();
		scope.cancel();
		try {
			await expect(runWithOperationContext(scope.context, () => native.run(value.pack)))
				.rejects.toMatchObject({ code: "operation_cancelled" });
			const requestDirectory = dirname(value.journal.storagePath);
			expect((await readdir(requestDirectory)).filter((name) => name.startsWith("native-request"))).toEqual([]);
		} finally {
			scope.dispose();
		}
	});
});
