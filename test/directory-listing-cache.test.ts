import { mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryListingCache } from "../src/directory-listing-cache.ts";
import { ignoredScanRoots, scanIgnoredDirectories } from "../src/ignored-directory-scan.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { createGitRepo, createNestedRepo } from "./fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	// macOS 的 tmpdir 位于 /var 下（符号链接到 /private/var）；扫描会拒绝 realpath 与自身不同的目录。
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-listing-")));
	roots.push(root);
	return root;
}

/** 把目录时间戳设到过去，使其离开 racy 窗口，缓存才允许复用。 */
async function age(path: string): Promise<void> {
	const past = new Date(Date.now() - 60_000);
	await utimes(path, past, past);
}

/** 不使用 native helper，强制走 TypeScript 扫描与缓存。 */
const noNative = { scan: async () => undefined };

describe("DirectoryListingCache", () => {
	it("目录稳定时复用目录项，新增或删除文件后重新枚举", async () => {
		const root = await temporaryRoot();
		await writeFile(join(root, "a.txt"), "a");
		await age(root);
		const cache = new DirectoryListingCache();
		const first = await cache.list(root);
		const second = await cache.list(root);
		expect(second).toBe(first);

		await writeFile(join(root, "b.txt"), "b");
		const added = await cache.list(root);
		expect(added?.entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"]);

		await age(root);
		await cache.list(root);
		await rm(join(root, "a.txt"));
		const removed = await cache.list(root);
		expect(removed?.entries.map((entry) => entry.name)).toEqual(["b.txt"]);
	});

	it("racy 窗口内刚变化的目录不复用缓存", async () => {
		const root = await temporaryRoot();
		await writeFile(join(root, "a.txt"), "a");
		const cache = new DirectoryListingCache();
		const first = await cache.list(root);
		const second = await cache.list(root);
		expect(second).not.toBe(first);
	});

	it("目录替换为同名新目录时重新枚举", async () => {
		const root = await temporaryRoot();
		const directory = join(root, "dir");
		await mkdir(directory);
		await writeFile(join(directory, "old.txt"), "old");
		await age(directory);
		const cache = new DirectoryListingCache();
		await cache.list(directory);
		await rm(directory, { recursive: true });
		await mkdir(directory);
		await writeFile(join(directory, "new.txt"), "new");
		await age(directory);
		const replaced = await cache.list(directory);
		expect(replaced?.entries.map((entry) => entry.name)).toEqual(["new.txt"]);
	});

	it.skipIf(process.platform === "win32")("分区不跟随父级链接，不跨仓库；同名替换不能通过绑定复核", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await mkdir(join(root, "pkg", "build"), { recursive: true });
		await mkdir(join(outside, "build"));
		await symlink(outside, join(root, "link"));
		const hints = new Set(["link/build", "pkg/build"]);
		const before = await ignoredScanRoots(root, hints);
		expect(before?.names).toEqual(["link", "pkg/build"]);
		expect(before?.directories).toEqual(["pkg/build"]);
		await rename(join(root, "pkg", "build"), join(outside, "old"));
		await mkdir(join(root, "pkg", "build"));
		const after = await ignoredScanRoots(root, hints);
		expect(after?.names).toEqual(before?.names);
		expect(after?.bindings).not.toEqual(before?.bindings);
		await writeFile(join(root, "pkg", ".git"), "标记");
		expect(await ignoredScanRoots(root, hints)).toBeUndefined();
	});

	it("嵌套分区按所有展开层累计参数预算，超过预算不返回部分清单", async () => {
		const root = await temporaryRoot();
		const parent = "p".repeat(120);
		await mkdir(join(root, parent, "build"), { recursive: true });
		// 名称自身并不长，但正向 pathspec 必须逐个携带完整父路径。
		for (let i = 0; i < 180; i += 1) await writeFile(join(root, parent, String(i)), "");
		expect(await ignoredScanRoots(root, new Set([`${parent}/build`]))).toBeUndefined();
	});

	it("ignored 扫描复用 discovery 的缓存后仍能发现新增叶子", async () => {
		const root = await temporaryRoot();
		const lib = join(root, "node_modules", "pkg", "lib");
		await mkdir(lib, { recursive: true });
		await writeFile(join(lib, "index.js"), "x");
		for (const path of [lib, join(root, "node_modules", "pkg"), join(root, "node_modules")]) await age(path);
		const cache = new DirectoryListingCache();
		expect(await scanIgnoredDirectories(root, ["node_modules"], cache)).toEqual(["node_modules/pkg/lib/index.js"]);

		await writeFile(join(lib, "extra.js"), "y");
		expect((await scanIgnoredDirectories(root, ["node_modules"], cache)).sort()).toEqual([
			"node_modules/pkg/lib/extra.js",
			"node_modules/pkg/lib/index.js",
		]);
	});

	it("RootDiscovery 复用缓存后仍能发现新增的嵌套仓库", async () => {
		const outer = await createGitRepo();
		roots.push(outer.root);
		await mkdir(join(outer.root, "packages"), { recursive: true });
		await age(join(outer.root, "packages"));
		const discovery = new RootDiscovery(undefined, noNative);
		const before = await discovery.discover(outer.root);
		expect(before.roots.map((root) => root.relativeRoot)).toEqual(["."]);

		await createNestedRepo(outer.root, "packages/child");
		const after = await discovery.discover(outer.root);
		expect(after.roots.map((root) => root.relativeRoot)).toEqual([".", "packages/child"]);
	});
});
