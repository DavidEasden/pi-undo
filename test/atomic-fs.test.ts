import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	fsyncDirectory,
	fsyncFile,
	writeBytesAtomic,
	writeContentAddressed,
	writeJsonAtomic,
} from "../src/atomic-fs.ts";
import {
	assertNoSymlinkEscape,
	relativeSafePath,
	sortDeletePaths,
	sortWritePaths,
} from "../src/path-safety.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-atomic-"));
	temporaryRoots.push(root);
	return root;
}

describe("atomic filesystem", () => {
	it("以同目录临时文件写入 JSON 并清理临时文件", async () => {
		const root = await temporaryRoot();
		const target = join(root, "state.json");

		await writeJsonAtomic(target, { z: 1, a: "状态" });

		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ z: 1, a: "状态" });
		expect(await readdir(root)).toEqual(["state.json"]);
		await fsyncFile(target);
		await fsyncDirectory(root);
	});

	it("完整写入字节并支持替换，不留下临时文件", async () => {
		const root = await temporaryRoot();
		const target = join(root, "blob");

		await writeBytesAtomic(target, new Uint8Array([1, 2, 3]), 0o640);
		await writeBytesAtomic(target, new Uint8Array([4, 5]));

		expect([...await readFile(target)]).toEqual([4, 5]);
		expect(await readdir(root)).toEqual(["blob"]);
	});

	it("内容寻址文件遇到目录目标时不会覆盖该目标", async () => {
		const root = await temporaryRoot();
		const target = join(root, "objects", "existing-directory");
		await mkdir(target, { recursive: true });

		await expect(writeContentAddressed(target, new Uint8Array([1]))).rejects.toBeDefined();
		expect((await readdir(join(root, "objects"))).includes("existing-directory")).toBe(true);
	});

	it("内容寻址文件相同内容幂等，不同内容不覆盖", async () => {
		const root = await temporaryRoot();
		const target = join(root, "objects", "abc");

		await writeContentAddressed(target, new Uint8Array([1, 2, 3]));
		await writeContentAddressed(target, new Uint8Array([1, 2, 3]));
		await expect(writeContentAddressed(target, new Uint8Array([1, 2, 4]))).rejects.toMatchObject({
			code: "content_mismatch",
		});
		expect([...await readFile(target)]).toEqual([1, 2, 3]);
	});

	it("内容寻址文件并发首次发布时不允许后写者覆盖", async () => {
		const root = await temporaryRoot();
		const target = join(root, "objects", "race");
		const values = Array.from({ length: 16 }, (_, index) => new Uint8Array(512 * 1024).fill(index + 1));

		const results = await Promise.allSettled(values.map((value) => writeContentAddressed(target, value)));

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
			reason: { code: "content_mismatch" },
		});
		const stored = await readFile(target);
		expect(values.some((value) => stored.equals(Buffer.from(value)))).toBe(true);
	});
});

describe("path safety", () => {
	it.each(["/absolute", "../escape", "nested/../../escape", "a\\b", "a\0b", "C:/absolute"])(
		"拒绝不安全相对路径：%s",
		(candidate) => {
			const root = "/tmp/workspace";
			expect(() => relativeSafePath(root, candidate)).toThrowError(
				expect.objectContaining({ code: "unsafe_path" }),
			);
		},
	);

	it("保留安全相对路径并按恢复方向排序", async () => {
		const root = await temporaryRoot();
		expect(relativeSafePath(root, "child/file.txt")).toBe("child/file.txt");
		expect(sortDeletePaths(["child", "child/deep/file", "app"])).toEqual([
			"child/deep/file",
			"app",
			"child",
		]);
		expect(sortWritePaths(["child", "child/deep/file", "app"])).toEqual([
			"app",
			"child",
			"child/deep/file",
		]);
	});

	it("拒绝中途 symlink 造成的逃逸", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await symlink(outside, join(root, "link"), "dir");

		await expect(assertNoSymlinkEscape(root, "link/secret.txt")).rejects.toMatchObject({
			code: "symlink_escape",
		});
	});
});
