import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NativeDirectoryScanner } from "../src/native-directory-scan.ts";
import { ResidentScanClient } from "../src/resident-scan-client.ts";
import { nativeExecutable } from "../src/native-restore.ts";

// 本地开发优先使用 cargo 产物；CI 的 package job 只有 native/bin 下的发布二进制。
const localBinary = join(process.cwd(), "native/pi-undo-fs/target/release/pi-undo-fs");
const binary = existsSync(localBinary) ? localBinary : nativeExecutable() ?? localBinary;

describe.skipIf(process.env.PI_UNDO_RUN_RESIDENT_LIVE !== "1" || (process.platform !== "darwin" && process.platform !== "linux") || !existsSync(binary))("resident scan smoke", () => {
	it.skipIf(process.platform !== "darwin")("近期目录缓存上的内容覆盖与合并结构事件仍更新叶子和仓库候选", async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-content-events-")));
		const workspace = join(base, "workspace");
		const cachePath = join(base, "directories.json");
		const client = new ResidentScanClient(binary, workspace, 5_000, cachePath);
		try {
			await mkdir(join(workspace, "deps/p0/deep"), { recursive: true });
			await writeFile(join(workspace, "value.txt"), "before\n");
			await writeFile(join(workspace, "deps/p0/deep/file"), "before\n");
			await Promise.all(Array.from({ length: 64 }, (_, index) =>
				mkdir(join(workspace, "deps", `p${index}`, "deep"), { recursive: true })));
			const scan = () => client.scan(undefined, ["deps"]);
			expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/p0/deep/file"] });
			const cache = JSON.parse(await readFile(cachePath, "utf8"));
			// 保留真实的近期缓存，防止测试只在 settled 目录上通过而漏掉原性能问题。
			expect(cache.directories.deps.racy).toBe(true);
			for (const content of ["after\n", "again\n"]) {
				await writeFile(join(workspace, "value.txt"), content);
				await writeFile(join(workspace, "deps/p0/deep/file"), content);
				// 新文件的 Created 可能合并进来；这里验证结果，确切标志的命中行为由回调测试覆盖。
				expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/p0/deep/file"] });
			}
			// 同一批次同时包含内容覆盖和结构变化，结构变化不得被前者吞掉。
			await writeFile(join(workspace, "value.txt"), "changed\n");
			await writeFile(join(workspace, "deps/p1/deep/new"), "new\n");
			await rm(join(workspace, "deps/p0/deep/file"));
			expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/p1/deep/new"] });
			await rename(join(workspace, "deps/p1"), join(workspace, "deps/moved"));
			expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/moved/deep/new"] });
			await rm(join(workspace, "deps/moved"), { recursive: true });
			await mkdir(join(base, "outside/.git"), { recursive: true });
			await symlink(join(base, "outside"), join(workspace, "deps/moved"));
			expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/moved"], repositories: [] });
			await writeFile(join(workspace, "deps/p2/deep/.git"), "invalid\n");
			const marked = await scan();
			expect(marked).toMatchObject({ ok: true, leaves: null,
				repositories: [expect.objectContaining({ path: "deps/p2/deep" })] });
			await rm(join(workspace, "deps/p2/deep/.git"));
			expect(await scan()).toMatchObject({ ok: true, leaves: ["deps/moved"], repositories: [] });
			// 新增目录只访问受影响路径，不能重扫整棵近期依赖树。
			await mkdir(join(workspace, "deps/fresh/nested"), { recursive: true });
			expect(await scan()).toMatchObject({ ok: true });
			await writeFile(join(workspace, "deps/fresh/nested/leaf"), "x\n");
			expect(await scan()).toMatchObject({
				ok: true, leaves: ["deps/fresh/nested/leaf", "deps/moved"],
			});
		} finally {
			await client.close();
			await rm(base, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "darwin")("变更探测返回精确路径且不消费目录缓存事件", async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-changes-")));
		const workspace = join(base, "workspace");
		const client = new ResidentScanClient(binary, workspace, 5_000);
		try {
			await mkdir(join(workspace, "src"), { recursive: true });
			await writeFile(join(workspace, "src/value.txt"), "before\n");
			const first = await client.scan();
			expect(first?.ok).toBe(true);
			const sequence = Number(first?.changeSeq);
			const instance = String(first?.changeInstance);
			expect(Number.isSafeInteger(sequence)).toBe(true);
			expect(instance.length).toBeGreaterThan(0);

			await writeFile(join(workspace, "src/value.txt"), "after\n");
			let delta: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 40; attempt += 1) {
				delta = await client.changesSince(sequence, instance);
				if (Array.isArray(delta?.changedFiles) && delta.changedFiles.includes("src/value.txt")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(delta).toMatchObject({
				ok: true,
				supported: true,
				trusted: true,
				changedFiles: ["src/value.txt"],
			});
			// helper 重启后序号不可复用：实例不匹配时必须拒绝快速路径。
			expect(await client.changesSince(sequence, "different-helper-instance")).toMatchObject({
				ok: true,
				trusted: false,
			});

			// peek 不消费事件：后续叶子扫描仍能看到同一批变化并返回最新内容对应的路径。
			const leaves = await client.scan(undefined, ["src"]);
			expect(leaves).toMatchObject({ ok: true, leaves: ["src/value.txt"] });
		} finally {
			await client.close();
			await rm(base, { recursive: true, force: true });
		}
	});

	it("预热后复用缓存并在目录事件后重扫", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-resident-live-")));
		const scanner = new NativeDirectoryScanner(binary);
		try {
			await mkdir(join(root, "node_modules", "pkg-a", ".git"), { recursive: true });
			scanner.prewarm(root);
			const first = await scanner.scan(root);
			expect(first?.repositories.map((entry) => entry.path)).toContain("node_modules/pkg-a");
			const cached = await scanner.scan(root);
			expect(cached?.repositories.map((entry) => entry.path)).toEqual(first?.repositories.map((entry) => entry.path));
			await mkdir(join(root, "node_modules", "pkg-b", ".git"), { recursive: true });
			await new Promise((resolve) => setTimeout(resolve, 300));
			const changed = await scanner.scan(root);
			expect(changed?.repositories.map((entry) => entry.path)).toContain("node_modules/pkg-b");
		} finally {
			await scanner.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
