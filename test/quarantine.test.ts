import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { MutationJournal } from "../src/mutation-journal.ts";
import {
	QuarantineManager,
	fingerprintAbsent,
	fingerprintBytes,
	fingerprintFile,
	fingerprintSymlink,
} from "../src/quarantine.ts";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
	root: string;
	journal: MutationJournal;
	manager: QuarantineManager;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-quarantine-"));
	temporaryRoots.push(root);
	const journal = new MutationJournal(join(root, "mutations.jsonl"), "op-1");
	return { root, journal, manager: new QuarantineManager({ workspaceRoot: root, journal }) };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QuarantineManager", () => {
	it("source 隔离后原路径被外部重建时 no-clobber 安装失败并保留两个版本", async () => {
		const { root, manager } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "source\n", { mode: 0o644 });

		await expect(manager.replaceFile({
			path: "a.txt",
			targetBytes: Buffer.from("target\n"),
			targetMode: 0o644,
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintBytes("a.txt", Buffer.from("target\n"), 0o644),
			beforeInstall: () => writeFile(path, "external\n"),
		})).rejects.toThrow("外部并发");

		expect(await readFile(path, "utf8")).toBe("external\n");
		const artifacts = await manager.inspectArtifacts();
		expect(artifacts).toContainEqual(expect.objectContaining({ role: "source", fingerprint: expect.any(String) }));
		expect(artifacts).toContainEqual(expect.objectContaining({ role: "target", fingerprint: expect.any(String) }));
	});

	it("普通文件替换使用 no-clobber 安装并保留可恢复 source", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "script.sh");
		await writeFile(path, "old\n", { mode: 0o644 });
		await chmod(path, 0o644);
		const target = Buffer.from("new\n");

		await manager.replaceFile({
			path: "script.sh",
			targetBytes: target,
			targetMode: 0o755,
			sourceFingerprint: await fingerprintFile(path, "script.sh"),
			targetFingerprint: fingerprintBytes("script.sh", target, 0o755),
		});

		expect(await readFile(path, "utf8")).toBe("new\n");
		expect((await lstat(path)).mode & 0o777).toBe(0o755);
		expect(await journal.load()).toMatchObject([{ state: "TARGET_VERIFIED", kind: "write" }]);
		expect(await manager.inspectArtifacts()).toContainEqual(expect.objectContaining({ role: "source" }));
	});

	it("delete 只隔离叶子并保留 source artifact", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "gone.txt");
		await writeFile(path, "keep for rollback\n");

		await manager.deleteLeaf({
			path: "gone.txt",
			sourceFingerprint: await fingerprintFile(path, "gone.txt"),
			targetFingerprint: fingerprintAbsent("gone.txt"),
		});

		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await journal.load()).toMatchObject([{ state: "TARGET_VERIFIED", kind: "delete" }]);
		expect(await manager.inspectArtifacts()).toContainEqual(expect.objectContaining({ role: "source" }));
	});

	it("symlink 只按 link text 指纹校验且安装不跟随目标", async () => {
		const { root, manager } = await fixture();
		const path = join(root, "link.txt");
		await symlink("old-target", path);

		await manager.replaceSymlink({
			path: "link.txt",
			targetLinkText: "../new-target",
			sourceFingerprint: await fingerprintSymlink(path, "link.txt"),
			targetFingerprint: fingerprintSymlink("link.txt", "../new-target"),
		});

		expect(await readlink(path)).toBe("../new-target");
	});

	it("absent source 可以 no-clobber 安装普通文件且不伪造 source artifact", async () => {
		const { root, journal, manager } = await fixture();
		const target = Buffer.from("new\n");

		await manager.replaceFile({
			path: "new.txt",
			targetBytes: target,
			targetMode: 0o644,
			sourceFingerprint: fingerprintAbsent("new.txt"),
			targetFingerprint: fingerprintBytes("new.txt", target, 0o644),
		});

		expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
		const [record] = await journal.load();
		expect(record).toMatchObject({ state: "TARGET_VERIFIED", sourceFingerprint: fingerprintAbsent("new.txt") });
		await expect(lstat(join(root, record.sourceArtifact))).rejects.toMatchObject({ code: "ENOENT" });
		await manager.cleanupMutation(record);
		await expect(journal.assertCleaned()).resolves.toBeUndefined();
	});

	it("absent source 可以 no-clobber 安装 symlink", async () => {
		const { root, journal, manager } = await fixture();

		await manager.replaceSymlink({
			path: "new-link",
			targetLinkText: "target.txt",
			sourceFingerprint: fingerprintAbsent("new-link"),
			targetFingerprint: fingerprintSymlink("new-link", "target.txt"),
		});

		expect(await readlink(join(root, "new-link"))).toBe("target.txt");
		expect(await journal.load()).toMatchObject([{ state: "TARGET_VERIFIED" }]);
	});

	it("absent source symlink 安装时外部抢占原路径会 fail closed", async () => {
		const { root, manager } = await fixture();

		await expect(manager.replaceSymlink({
			path: "new-link",
			targetLinkText: "target.txt",
			sourceFingerprint: fingerprintAbsent("new-link"),
			targetFingerprint: fingerprintSymlink("new-link", "target.txt"),
			beforeInstall: () => writeFile(join(root, "new-link"), "external\n"),
		})).rejects.toThrow("外部并发");

		expect(await readFile(join(root, "new-link"), "utf8")).toBe("external\n");
	});

	it("absent source rollback 删除已验证 target 并幂等清理，未知外部内容则保留", async () => {
		const clean = await fixture();
		const target = Buffer.from("new\n");
		await clean.manager.replaceFile({
			path: "new.txt",
			targetBytes: target,
			targetMode: 0o644,
			sourceFingerprint: fingerprintAbsent("new.txt"),
			targetFingerprint: fingerprintBytes("new.txt", target, 0o644),
		});
		const [record] = await clean.journal.load();

		await clean.manager.restoreMutation(record);
		await clean.manager.restoreMutation(record);

		await expect(lstat(join(clean.root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(clean.journal.assertCleaned()).resolves.toBeUndefined();
		expect(await clean.manager.inspectArtifacts()).toEqual([]);

		const conflict = await fixture();
		await conflict.manager.replaceFile({
			path: "new.txt",
			targetBytes: target,
			targetMode: 0o644,
			sourceFingerprint: fingerprintAbsent("new.txt"),
			targetFingerprint: fingerprintBytes("new.txt", target, 0o644),
		});
		const [conflictRecord] = await conflict.journal.load();
		await rm(join(conflict.root, "new.txt"));
		await writeFile(join(conflict.root, "new.txt"), "external\n");

		await expect(conflict.manager.restoreMutation(conflictRecord)).rejects.toThrow("外部并发");
		expect(await readFile(join(conflict.root, "new.txt"), "utf8")).toBe("external\n");
	});

	it("artifact 名碰撞时生成新 nonce 且不认领同名前缀用户文件", async () => {
		const { root, journal } = await fixture();
		const colliding = `.pi-undo-q1-${"0".repeat(32)}-source`;
		await writeFile(join(root, colliding), "user\n");
		const nonces = ["0".repeat(32), "1".repeat(32)];
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			nonce: () => nonces.shift()!,
		});
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");

		await manager.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});

		expect(await readFile(join(root, colliding), "utf8")).toBe("user\n");
		expect((await manager.inspectArtifacts()).map((artifact) => artifact.path)).not.toContain(
			colliding,
		);
		expect((await manager.inspectArtifacts()).map((artifact) => artifact.path)).toContain(
			`.pi-undo-q1-${"1".repeat(32)}-source`,
		);
	});

	it("hard-link 不支持时 fail safe，不使用覆盖式 rename", async () => {
		const { root, journal } = await fixture();
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			linkFile: async () => {
				throw Object.assign(new Error("不支持 hard-link"), { code: "EXDEV" });
			},
		});
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");

		await expect(manager.replaceFile({
			path: "a.txt",
			targetBytes: Buffer.from("new\n"),
			targetMode: 0o644,
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintBytes("a.txt", Buffer.from("new\n"), 0o644),
		})).rejects.toMatchObject({ code: "EXDEV" });

		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await manager.inspectArtifacts()).toContainEqual(expect.objectContaining({ role: "source" }));
	});

	it("cleanup 只清理 journal 精确登记且指纹匹配的 artifact，并可幂等重试", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		await manager.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});
		const [record] = await journal.load();
		await writeFile(join(root, ".pi-undo-q1-user-source"), "user\n");

		await manager.cleanupMutation(record);
		await manager.cleanupMutation(record);

		expect(await manager.inspectArtifacts()).toEqual([]);
		expect(await readFile(join(root, ".pi-undo-q1-user-source"), "utf8")).toBe("user\n");
		expect(await readdir(root)).toContain(".pi-undo-q1-user-source");
		expect(await journal.load()).toMatchObject([{ state: "CLEANED" }]);
	});

	it("rollForwardMutation 从 SOURCE_VERIFIED 的 target artifact 完成普通文件安装", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		await expect(manager.replaceFile({
			path: "a.txt",
			targetBytes: Buffer.from("new\n"),
			targetMode: 0o644,
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintBytes("a.txt", Buffer.from("new\n"), 0o644),
			beforeInstall: () => {
				throw new Error("模拟崩溃");
			},
		})).rejects.toThrow("模拟崩溃");
		const [record] = await journal.load();

		await manager.rollForwardMutation(record);

		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(await journal.load()).toMatchObject([{ state: "TARGET_VERIFIED" }]);
	});

	it("restoreMutation 在原路径缺失时 no-clobber 恢复 source artifact", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		await manager.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});
		const [record] = await journal.load();

		await manager.restoreMutation(record);

		expect(await readFile(path, "utf8")).toBe("old\n");
	});

	it("restore 安装前原路径被外部重建时保留 external 与 source artifact", async () => {
		const { root, journal } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		const initial = new QuarantineManager({ workspaceRoot: root, journal });
		await initial.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});
		const [record] = await journal.load();
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			beforeRestoreInstall: () => writeFile(path, "external\n"),
		});

		await expect(manager.restoreMutation(record)).rejects.toThrow("外部并发");

		expect(await readFile(path, "utf8")).toBe("external\n");
		expect(await readFile(join(root, record.sourceArtifact), "utf8")).toBe("old\n");
	});

	it("source artifact 创建前被外部抢占时不覆盖 artifact 且不移除 original", async () => {
		const { root, journal } = await fixture();
		const path = join(root, "a.txt");
		const nonce = "2".repeat(32);
		const sourceArtifact = `.pi-undo-q1-${nonce}-source`;
		await writeFile(path, "old\n");
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			nonce: () => nonce,
			beforeSourceCapture: () => writeFile(join(root, sourceArtifact), "external artifact\n"),
		});

		await expect(manager.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		})).rejects.toThrow("外部并发");

		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(await readFile(join(root, sourceArtifact), "utf8")).toBe("external artifact\n");
	});

	it("source artifact 建立后 original 被替换时再次 fingerprint 并保留两个版本", async () => {
		const { root, journal } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			beforeSourceRemove: async () => {
				await rm(path);
				await writeFile(path, "external\n");
			},
		});

		await expect(manager.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		})).rejects.toThrow("fingerprint");

		expect(await readFile(path, "utf8")).toBe("external\n");
		expect(await manager.inspectArtifacts()).toContainEqual(expect.objectContaining({ role: "source" }));
	});

	it("restore 安装成功但 source 尚在时重试会识别自身结果并完成清理", async () => {
		const { root, journal } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		const initial = new QuarantineManager({ workspaceRoot: root, journal });
		await initial.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});
		const [record] = await journal.load();
		const crashing = new QuarantineManager({
			workspaceRoot: root,
			journal,
			beforeRestoreSourceCleanup: () => {
				throw new Error("模拟 restore cleanup 前崩溃");
			},
		});
		await expect(crashing.restoreMutation(record)).rejects.toThrow("模拟 restore cleanup 前崩溃");

		await new QuarantineManager({ workspaceRoot: root, journal }).restoreMutation(record);

		expect(await readFile(path, "utf8")).toBe("old\n");
		await expect(lstat(join(root, record.sourceArtifact))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("restore source 已删但调用未返回时重试视为已经收敛", async () => {
		const { root, journal } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");
		const initial = new QuarantineManager({ workspaceRoot: root, journal });
		await initial.deleteLeaf({
			path: "a.txt",
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintAbsent("a.txt"),
		});
		const [record] = await journal.load();
		const crashing = new QuarantineManager({
			workspaceRoot: root,
			journal,
			afterRestoreSourceCleanup: () => {
				throw new Error("模拟 restore 返回前崩溃");
			},
		});
		await expect(crashing.restoreMutation(record)).rejects.toThrow("模拟 restore 返回前崩溃");

		await expect(new QuarantineManager({ workspaceRoot: root, journal }).restoreMutation(record))
			.resolves.toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("old\n");
	});

	it("replaceSymlink 在任何目录项 mutation 前拒绝 target link fingerprint 不匹配", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "link.txt");
		await symlink("old-target", path);

		await expect(manager.replaceSymlink({
			path: "link.txt",
			targetLinkText: "new-target",
			sourceFingerprint: await fingerprintSymlink(path, "link.txt"),
			targetFingerprint: fingerprintSymlink("link.txt", "different-target"),
		})).rejects.toThrow("fingerprint");

		expect(await readlink(path)).toBe("old-target");
		expect(await journal.load()).toEqual([]);
	});

	it("普通文件 mode 合同只接受 Git manifest 可表达的 0644 与 0755", async () => {
		const { root, journal, manager } = await fixture();
		const path = join(root, "a.txt");
		await writeFile(path, "old\n");

		await expect(manager.replaceFile({
			path: "a.txt",
			targetBytes: Buffer.from("new\n"),
			targetMode: 0o600,
			sourceFingerprint: await fingerprintFile(path, "a.txt"),
			targetFingerprint: fingerprintBytes("a.txt", Buffer.from("new\n"), 0o600),
		})).rejects.toThrow("mode");

		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(await journal.load()).toEqual([]);
	});

	it("target artifact 创建前父目录变成外部 symlink 时 fail closed", async () => {
		const { root, journal } = await fixture();
		const external = await mkdtemp(join(tmpdir(), "pi-undo-quarantine-external-"));
		temporaryRoots.push(external);
		await mkdir(join(root, "dir"));
		await writeFile(join(root, "dir/a.txt"), "old\n");
		const sourceFingerprint = await fingerprintFile(join(root, "dir/a.txt"), "dir/a.txt");
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			beforeTargetCreate: async () => {
				await rename(join(root, "dir"), join(root, "held"));
				await symlink(external, join(root, "dir"));
			},
		});

		await expect(manager.replaceFile({
			path: "dir/a.txt",
			targetBytes: Buffer.from("new\n"),
			targetMode: 0o644,
			sourceFingerprint,
			targetFingerprint: fingerprintBytes("dir/a.txt", Buffer.from("new\n"), 0o644),
		})).rejects.toThrow("symlink");

		expect(await readFile(join(root, "held/a.txt"), "utf8")).toBe("old\n");
		expect(await readdir(external)).toEqual([]);
	});

	it("target 安装前父目录变成外部 symlink 时不在外部目录安装", async () => {
		const { root, manager } = await fixture();
		const external = await mkdtemp(join(tmpdir(), "pi-undo-quarantine-external-"));
		temporaryRoots.push(external);
		await mkdir(join(root, "dir"));
		await writeFile(join(root, "dir/a.txt"), "old\n");

		await expect(manager.replaceFile({
			path: "dir/a.txt",
			targetBytes: Buffer.from("new\n"),
			targetMode: 0o644,
			sourceFingerprint: await fingerprintFile(join(root, "dir/a.txt"), "dir/a.txt"),
			targetFingerprint: fingerprintBytes("dir/a.txt", Buffer.from("new\n"), 0o644),
			beforeInstall: async () => {
				await rename(join(root, "dir"), join(root, "held"));
				await symlink(external, join(root, "dir"));
			},
		})).rejects.toThrow("symlink");

		expect(await readdir(external)).toEqual([]);
		expect((await readdir(join(root, "held"))).some((name) => name.endsWith("-source"))).toBe(true);
	});

	it("original unlink 前父目录变成外部 symlink 时不删除外部同名文件", async () => {
		const { root, journal } = await fixture();
		const external = await mkdtemp(join(tmpdir(), "pi-undo-quarantine-external-"));
		temporaryRoots.push(external);
		await mkdir(join(root, "dir"));
		await writeFile(join(root, "dir/a.txt"), "old\n");
		await writeFile(join(external, "a.txt"), "external\n");
		const manager = new QuarantineManager({
			workspaceRoot: root,
			journal,
			beforeSourceRemove: async () => {
				await rename(join(root, "dir"), join(root, "held"));
				await symlink(external, join(root, "dir"));
			},
		});

		await expect(manager.deleteLeaf({
			path: "dir/a.txt",
			sourceFingerprint: await fingerprintFile(join(root, "dir/a.txt"), "dir/a.txt"),
			targetFingerprint: fingerprintAbsent("dir/a.txt"),
		})).rejects.toThrow("symlink");

		expect(await readFile(join(external, "a.txt"), "utf8")).toBe("external\n");
		expect(await readFile(join(root, "held/a.txt"), "utf8")).toBe("old\n");
	});

	it.each([
		"INTENT",
		"SOURCE_QUARANTINED",
		"SOURCE_VERIFIED",
		"TARGET_INSTALLED",
		"TARGET_VERIFIED",
	] as const)("restoreMutation 从 %s 现场 rollback 后幂等终结为 CLEANED", async (state) => {
		const { root, journal, manager } = await fixture();
		const path = "a.txt";
		const sourceArtifact = `.pi-undo-q1-${"a".repeat(32)}-source`;
		const targetArtifact = `.pi-undo-q1-${"a".repeat(32)}-target`;
		const source = Buffer.from("old\n");
		const target = Buffer.from("new\n");
		const sourceFingerprint = fingerprintBytes(path, source, 0o644);
		const targetFingerprint = fingerprintBytes(path, target, 0o644);
		if (state === "INTENT") {
			await writeFile(join(root, path), source, { mode: 0o644 });
		} else {
			await writeFile(join(root, sourceArtifact), source, { mode: 0o644 });
		}
		if (state === "TARGET_INSTALLED" || state === "TARGET_VERIFIED") {
			await writeFile(join(root, path), target, { mode: 0o644 });
		}
		if (state !== "TARGET_VERIFIED") {
			await writeFile(join(root, targetArtifact), target, { mode: 0o644 });
		}
		let record = await journal.begin({
			kind: "write",
			path,
			sourceArtifact,
			targetArtifact,
			sourceFingerprint,
			targetFingerprint,
		});
		for (const next of ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"] as const) {
			if (rollbackStateOrder(next) > rollbackStateOrder(state)) break;
			record = await journal.advance(record.ordinal, next);
		}

		await manager.restoreMutation(record);
		await manager.restoreMutation(record);

		expect(await readFile(join(root, path), "utf8")).toBe("old\n");
		await expect(lstat(join(root, sourceArtifact))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(join(root, targetArtifact))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(journal.assertCleaned()).resolves.toBeUndefined();
	});

	it("TARGET_INSTALLED rollback 遇到未知 original 时保留所有内容且不写 CLEANED", async () => {
		const { root, journal, manager } = await fixture();
		const path = "a.txt";
		const sourceArtifact = `.pi-undo-q1-${"b".repeat(32)}-source`;
		const targetArtifact = `.pi-undo-q1-${"b".repeat(32)}-target`;
		await writeFile(join(root, sourceArtifact), "old\n");
		await writeFile(join(root, targetArtifact), "new\n");
		await writeFile(join(root, path), "external\n");
		let record = await journal.begin({
			kind: "write",
			path,
			sourceArtifact,
			targetArtifact,
			sourceFingerprint: fingerprintBytes(path, Buffer.from("old\n"), 0o644),
			targetFingerprint: fingerprintBytes(path, Buffer.from("new\n"), 0o644),
		});
		for (const state of ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED"] as const) {
			record = await journal.advance(1, state);
		}

		await expect(manager.restoreMutation(record)).rejects.toThrow("外部并发");

		expect(await readFile(join(root, path), "utf8")).toBe("external\n");
		expect(await readFile(join(root, sourceArtifact), "utf8")).toBe("old\n");
		expect(await journal.load()).toMatchObject([{ state: "TARGET_INSTALLED" }]);
	});

	it("TARGET_VERIFIED symlink rollback 使用 link fingerprint 收敛并写 CLEANED", async () => {
		const { root, journal, manager } = await fixture();
		const path = "link.txt";
		const sourceArtifact = `.pi-undo-q1-${"c".repeat(32)}-source`;
		await symlink("old-target", join(root, sourceArtifact));
		await symlink("new-target", join(root, path));
		let record = await journal.begin({
			kind: "symlink",
			path,
			sourceArtifact,
			targetArtifact: null,
			sourceFingerprint: fingerprintSymlink(path, "old-target"),
			targetFingerprint: fingerprintSymlink(path, "new-target"),
		});
		for (const state of ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"] as const) {
			record = await journal.advance(1, state);
		}

		await manager.restoreMutation(record);
		await manager.restoreMutation(record);

		expect(await readlink(join(root, path))).toBe("old-target");
		await expect(journal.assertCleaned()).resolves.toBeUndefined();
	});
});

function rollbackStateOrder(state: string): number {
	return ["INTENT", "SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"]
		.indexOf(state);
}
