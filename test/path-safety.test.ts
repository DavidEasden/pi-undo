import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { assertNoSymlinkParents, MutationPathIndex, pathSetsOverlap } from "../src/path-safety.ts";

describe("pathSetsOverlap", () => {
	it.each([
		[["visible/file.txt"], ["visible/file.txt"]],
		[["visible"], ["visible/file.txt"]],
		[["visible/file.txt/child.txt"], ["visible/file.txt"]],
		[["a/b/c"], ["a"]],
	] as const)("识别 exact、祖先和后代冲突", (left, right) => {
		expect(pathSetsOverlap(left, right)).toBe(true);
	});

	it.each([
		[["visible-file.txt"], ["visible/file.txt"]],
		[["visible/file.txt-other"], ["visible/file.txt"]],
		[["visible/file"], ["visible/file.txt"]],
		[["visible/file.txt2/child.txt"], ["visible/file.txt"]],
		[[], ["visible/file.txt"]],
		[["visible/file.txt"], []],
	] as const)("保持严格的路径组件边界", (left, right) => {
		expect(pathSetsOverlap(left, right)).toBe(false);
	});

	it("与原双重路径扫描保持确定性差分等价", () => {
		let state = 0x5eed1234;
		const random = (): number => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state;
		};
		const path = (): string => {
			const depth = 1 + random() % 5;
			return Array.from({ length: depth }, () => `p${random() % 24}`).join("/");
		};
		for (let iteration = 0; iteration < 5_000; iteration += 1) {
			const left = Array.from({ length: random() % 24 }, path);
			const right = Array.from({ length: random() % 24 }, path);
			expect(pathSetsOverlap(left, right)).toBe(legacyPathSetsOverlap(left, right));
		}
	});
});

describe("assertNoSymlinkParents", () => {
	it("允许叶子 symlink，但拒绝任一共享父目录 symlink", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-path-parents-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-undo-path-outside-"));
		try {
			await mkdir(join(root, "safe"));
			await writeFile(join(root, "safe", "file.txt"), "safe\n");
			await symlink(join(outside, "target.txt"), join(root, "safe", "leaf-link"));
			await expect(assertNoSymlinkParents(root, ["safe/file.txt", "safe/leaf-link"]))
				.resolves.toBeUndefined();

			await symlink(outside, join(root, "escape"));
			await expect(assertNoSymlinkParents(root, ["safe/file.txt", "escape/file.txt"]))
				.rejects.toMatchObject({ code: "symlink_escape" });
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});

function legacyPathSetsOverlap(leftPaths: readonly string[], rightPaths: readonly string[]): boolean {
	return leftPaths.some((left) => rightPaths.some((right) =>
		isPathAtOrBelow(left, right) || isPathAtOrBelow(right, left),
	));
}

function isPathAtOrBelow(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

describe("MutationPathIndex", () => {
	const cases: Array<[string, readonly string[], readonly string[], string, boolean]> = [
		["mutation 与 path 相同", ["a/b"], [], "a/b", true],
		["mutation 是 path 的后代", ["a/b/c"], [], "a/b", true],
		["path 是 mutation 的后代", [], ["a/b"], "a/b/c", true],
		["仅共享字符串前缀不算重叠", ["a-b"], [], "a", false],
		["仅共享文件名前缀不算重叠", ["a/bc"], [], "a/b", false],
		["完全无关", ["x/y"], ["z"], "a/b", false],
	];
	it.each(cases)("%s", (_label, deletePaths, writePaths, candidate, expected) => {
		expect(new MutationPathIndex(deletePaths, writePaths).affects(candidate)).toBe(expected);
	});
	it("与原线性谓词在随机路径集合上等价", () => {
		let state = 0x9e3779b9;
		const random = (): number => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			return state;
		};
		const path = (): string => Array.from({ length: 1 + random() % 4 }, () => `p${random() % 8}`).join("/");
		const linear = (candidate: string, mutations: readonly string[]): boolean =>
			mutations.some((mutation) =>
				mutation === candidate ||
				mutation.startsWith(`${candidate}/`) ||
				candidate.startsWith(`${mutation}/`),
			);
		for (let iteration = 0; iteration < 2_000; iteration += 1) {
			const deletePaths = Array.from({ length: random() % 8 }, path);
			const writePaths = Array.from({ length: random() % 8 }, path);
			const index = new MutationPathIndex(deletePaths, writePaths);
			const candidate = path();
			expect(index.affects(candidate)).toBe(linear(candidate, [...deletePaths, ...writePaths]));
		}
	});
});
