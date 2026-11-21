import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GitRunner } from "../src/git-runner.ts";
import { allowsNativeLeafCache } from "../src/native-capabilities.ts";
import { NativeDirectoryScanner } from "../src/native-directory-scan.ts";
import { nativeExecutable } from "../src/native-restore.ts";
import { createOperationScope, runWithOperationContext } from "../src/operation-context.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { createGitRepo, runGit, writeFile as writeFixtureFile } from "./fixtures.ts";

const localBinary = join(process.cwd(), "native/pi-undo-fs/target/release/pi-undo-fs");
const binary = existsSync(localBinary) ? localBinary : nativeExecutable();

describe.skipIf(process.env.PI_UNDO_DISABLE_NATIVE === "1" || binary === undefined ||
	(process.platform !== "darwin" && process.platform !== "linux"))("经过事件复核的忽略叶子", () => {
	it("跨请求重新检查深层增删、移动、符号链接、Git 标记和进程重启", async (context) => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-leaves-")));
		const workspace = join(base, "workspace");
		await mkdir(join(workspace, "deps/a/deep"), { recursive: true });
		const scanner = new NativeDirectoryScanner(binary);
		try {
			if (!await allowsNativeLeafCache(workspace)) return context.skip();
			await writeFile(join(workspace, "deps/a/deep/one"), "1");
			await scanner.scan(workspace);
			const leaves = () => scanner.scanLeaves(workspace, ["deps"]);
			await expect(leaves()).resolves.toEqual(["deps/a/deep/one"]);
			await writeFile(join(workspace, "deps/a/deep/新\n文件"), "2");
			await expect(leaves()).resolves.toEqual(["deps/a/deep/one", "deps/a/deep/新\n文件"]);
			await rm(join(workspace, "deps/a/deep/one"));
			await expect(leaves()).resolves.toEqual(["deps/a/deep/新\n文件"]);
			await rename(join(workspace, "deps/a"), join(workspace, "deps/b"));
			await expect(leaves()).resolves.toEqual(["deps/b/deep/新\n文件"]);
			await mkdir(join(base, "incoming/deep"), { recursive: true });
			await writeFile(join(base, "incoming/deep/file"), "3");
			await rename(join(base, "incoming"), join(workspace, "deps/incoming"));
			await expect(leaves()).resolves.toEqual(["deps/b/deep/新\n文件", "deps/incoming/deep/file"]);
			await rename(join(workspace, "deps/incoming"), join(base, "outside"));
			await symlink(join(base, "outside"), join(workspace, "deps/link"));
			await expect(leaves()).resolves.toEqual(["deps/b/deep/新\n文件", "deps/link"]);
			await writeFile(join(workspace, "deps/b/deep/.git"), "invalid");
			await expect(leaves()).resolves.toBeUndefined();
			await rm(join(workspace, "deps/b/deep/.git"));
			await expect(leaves()).resolves.toEqual(["deps/b/deep/新\n文件", "deps/link"]);
			await scanner.dispose();
			await writeFile(join(workspace, "deps/b/deep/after-restart"), "4");
			await scanner.scan(workspace);
			await expect(leaves()).resolves.toEqual(["deps/b/deep/after-restart", "deps/b/deep/新\n文件", "deps/link"]);
			await rename(join(workspace, "deps/b"), join(base, "moved-out"));
			await symlink(join(base, "moved-out"), join(workspace, "deps/b"));
			await expect(leaves()).resolves.toEqual(["deps/b", "deps/link"]);
		} finally {
			await scanner.dispose();
			await rm(base, { recursive: true, force: true });
		}
	});

	it("目录结构复用后仍捕获同长度内容覆盖、执行权限和忽略规则变化", async (context) => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-content-capture-")));
		const workspace = join(base, "workspace");
		await createGitRepo(workspace);
		const scanner = new NativeDirectoryScanner(binary);
		const discovery = new RootDiscovery(new GitRunner(), scanner);
		const store = new SnapshotStore({ storeRoot: join(base, "store"), discovery });
		try {
			if (!await allowsNativeLeafCache(workspace)) return context.skip();
			await writeFixtureFile(workspace, ".gitignore", "deps/\n*.log\n");
			await writeFixtureFile(workspace, "value.txt", "before\n");
			await writeFixtureFile(workspace, "output.log", "ignored\n");
			await Promise.all(Array.from({ length: 64 }, (_, index) =>
				mkdir(join(workspace, "deps", `p${index}`), { recursive: true })));
			let baseline = await store.capture(await discovery.discover(workspace));
			await writeFile(join(workspace, "value.txt"), "after!\n");
			await chmod(join(workspace, "value.txt"), 0o755);
			const after = await store.captureBaseline(await discovery.discover(workspace), baseline);
			const entry = (await store.listTree(after.manifestId, ".")).find((entry) => entry.relativePath === "value.txt");
			expect(entry).toMatchObject({ kind: "file", mode: 0o100755 });
			expect(Buffer.from(await store.readBlob(after.manifestId, ".", entry!.blobId!)).toString("utf8")).toBe("after!\n");
			expect(after.roots[0]?.ignoredPresentPaths).toContain("output.log");
			baseline = after;
			await writeFile(join(workspace, ".gitignore"), "deps/\n*.tmp\n");
			const reclassified = await store.captureBaseline(await discovery.discover(workspace), baseline);
			expect(reclassified.roots[0]?.ignoredPresentPaths).not.toContain("output.log");
			expect((await store.listTree(reclassified.manifestId, ".")).map((entry) => entry.relativePath)).toContain("output.log");
		} finally {
			await discovery.dispose();
			await rm(base, { recursive: true, force: true });
		}
	});

	it("同一操作内的多次 capture 与 Git 逐项一致，规则/index 变化会放弃原分区", async (context) => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-leaf-proof-")));
		const workspace = join(base, "workspace");
		await createGitRepo(workspace);
		const git = new GitRunner();
		const scanner = new NativeDirectoryScanner(binary);
		const discovery = new RootDiscovery(git, scanner);
		const store = new SnapshotStore({ storeRoot: join(base, "store"), discovery, git, ignoredProofPath: "partition" });
		const scope = createOperationScope({ timeoutMs: 30_000 });
		try {
			if (!await allowsNativeLeafCache(workspace)) return context.skip();
			await writeFixtureFile(workspace, ".gitignore", "deps/\n*.log\n");
			for (let start = 0; start < 1088; start += 64) {
				await Promise.all(Array.from({ length: 64 }, (_, index) =>
					writeFixtureFile(workspace, `deps/p${start + index}/file`, "x")));
			}
			const compare = async () => {
				const manifest = await runWithOperationContext(scope.context, async () =>
					store.capture(await discovery.discover(workspace)));
				const expected = (await runGit(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "."]))
					.split("\0").filter(Boolean).sort();
				expect(manifest.roots[0]?.ignoredPresentPaths).toEqual(expected);
				return expected;
			};
			await compare();
			const original = scanner.scanLeaves.bind(scanner);
			const scan = vi.spyOn(scanner, "scanLeaves");
			try {
				await writeFixtureFile(workspace, "deps/p0/deep/two", "2");
				expect(await compare()).toContain("deps/p0/deep/two");
				expect(scan).toHaveBeenCalled();
				expect((await scan.mock.results.at(-1)?.value)?.length).toBe(1089);
				await rm(join(workspace, "deps/p0/deep/two"));
				expect(await compare()).not.toContain("deps/p0/deep/two");

				// index 位于监听排除的 .git 内；每次仍要由 Git 核验，不能只信事件缓存。
				scan.mockImplementationOnce(async (...args) => {
					const paths = await original(...args);
					await runGit(workspace, ["add", "-f", "deps/p1/file"]);
					return paths;
				});
				expect(await compare()).not.toContain("deps/p1/file");
				await runGit(workspace, ["rm", "--cached", "-f", "deps/p1/file"]);
				scan.mockImplementationOnce(async (...args) => {
					const paths = await original(...args);
					await writeFile(join(workspace, ".gitignore"), "deps/*\n!deps/p1/\n*.log\n");
					return paths;
				});
				expect(await compare()).not.toContain("deps/p1/file");
			} finally { scan.mockRestore(); }
		} finally {
			scope.dispose();
			await discovery.dispose();
			await rm(base, { recursive: true, force: true });
		}
	});
});
