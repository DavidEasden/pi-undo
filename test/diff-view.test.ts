import { generateDiffString, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { compareDiffText } from "../src/diff-text.ts";
import { browseDiff } from "../src/diff-ui.ts";

import {
	buildFileLabel,
	computeCheckpointDiff,
	formatDiffSummary,
	prepareCheckpointDiff,
	sanitizeDisplayText,
	type DiffSource,
} from "../src/diff-view.ts";
import type { ManifestId, RestorePath, SnapshotManifest, SnapshotRoot } from "../src/model.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

const beforeId = "a".repeat(64) as ManifestId;
const afterId = "b".repeat(64) as ManifestId;

function root(relativeRoot: string): SnapshotRoot {
	return {
		relativeRoot,
		parentRoot: relativeRoot === "." ? null : ".",
		state: "active",
		sourceIdentity: `source:${relativeRoot}`,
		privateRepositoryId: `private:${relativeRoot}`,
		treeId: "c".repeat(40),
		coverage: "complete",
		ignorePolicy: "git-check-ignore-v1",
		ignoredPresentPaths: [],
		ignoreClosure: "d".repeat(64),
		objectClosure: "e".repeat(64),
	};
}

function manifest(manifestId: ManifestId): SnapshotManifest {
	return {
		schemaVersion: 1,
		manifestId,
		workspaceIdentity: "/workspace",
		topologyFingerprint: "f".repeat(64),
		coverage: "complete",
		roots: [root("."), root("nested")],
		createdAt: "2026-07-26T00:00:00.000Z",
	};
}

function file(relativePath: string, blobId: string, size = 1): RestorePath {
	return { relativePath, kind: "file", mode: 0o100644, blobId, size, rootHash: "tree" };
}

function symlink(relativePath: string, linkText: string): RestorePath {
	return { relativePath, kind: "symlink", mode: 0o120000, blobId: "link", size: linkText.length, rootHash: "tree", linkText };
}

function directory(relativePath: string): RestorePath {
	return { relativePath, kind: "directory", mode: 0o755, blobId: null, size: 0, rootHash: "tree" };
}

function source(): DiffSource {
	const trees = new Map<string, readonly RestorePath[]>([
		[`${beforeId}:.`, [
			file("modified.ts", "old-modified"),
			file("deleted.ts", "old-deleted"),
			file("binary.dat", "old-binary"),
			symlink("current-link", "old-target"),
			directory("empty-dir"),
		]],
		[`${afterId}:.`, [
			file("modified.ts", "new-modified"),
			file("added.ts", "new-added"),
			file("binary.dat", "new-binary"),
			symlink("current-link", "new-target"),
			directory("empty-dir"),
		]],
		[`${beforeId}:nested`, [file("child.ts", "old-child")]],
		[`${afterId}:nested`, [file("child.ts", "new-child")]],
	]);
	const blobs = new Map<string, Uint8Array>([
		[`${beforeId}:.:old-modified`, Buffer.from("const value = 1;\n")],
		[`${afterId}:.:new-modified`, Buffer.from("const value = 2;\n")],
		[`${beforeId}:.:old-deleted`, Buffer.from("deleted\n")],
		[`${afterId}:.:new-added`, Buffer.from("added\nsecond\n")],
		[`${beforeId}:.:old-binary`, Uint8Array.of(0, 1, 2)],
		[`${afterId}:.:new-binary`, Uint8Array.of(0, 3, 4)],
		[`${beforeId}:nested:old-child`, Buffer.from("old child\n")],
		[`${afterId}:nested:new-child`, Buffer.from("new child\n")],
	]);
	return {
		loadManifest: async (id) => manifest(id),
		listTree: async (id, rootPath) => trees.get(`${id}:${rootPath}`) ?? [],
		readBlob: async (id, rootPath, blobId) => {
			const bytes = blobs.get(`${id}:${rootPath}:${blobId}`);
			if (bytes === undefined) throw new Error("blob missing");
			return bytes;
		},
	};
}

describe("computeCheckpointDiff", () => {
	it("计算新增、删除、修改、二进制、symlink 与嵌套 root 的逐文件 diff", async () => {
		const diffs = await computeCheckpointDiff(source(), {
			beforeManifestId: beforeId,
			afterManifestId: afterId,
			changedPaths: ["added.ts", "binary.dat", "current-link", "deleted.ts", "empty-dir", "modified.ts", "nested/child.ts"],
		});

		expect(diffs.map(({ path, status, kind, additions, deletions }) => ({ path, status, kind, additions, deletions }))).toEqual([
			{ path: "added.ts", status: "added", kind: "text", additions: 2, deletions: 0 },
			{ path: "binary.dat", status: "modified", kind: "binary", additions: 0, deletions: 0 },
			{ path: "current-link", status: "modified", kind: "symlink", additions: 1, deletions: 1 },
			{ path: "deleted.ts", status: "deleted", kind: "text", additions: 0, deletions: 1 },
			{ path: "modified.ts", status: "modified", kind: "text", additions: 1, deletions: 1 },
			{ path: "nested/child.ts", status: "modified", kind: "text", additions: 1, deletions: 1 },
		]);
		expect(diffs.find((diff) => diff.path === "modified.ts")?.diff).toContain("-1 const value = 1;");
		expect(diffs.find((diff) => diff.path === "modified.ts")?.diff).toContain("+1 const value = 2;");
		expect(diffs.some((diff) => diff.path === "empty-dir")).toBe(false);
	});

	it("按所属 root 查询变更，浏览列表只在选中文件时读取该文件", async () => {
		const base = source();
		const reads = vi.spyOn(base, "readBlob");
		const lists = vi.spyOn(base, "listTree");
		const view = await prepareCheckpointDiff(base, {
			beforeManifestId: beforeId, afterManifestId: afterId, changedPaths: ["nested/child.ts", "added.ts"],
		});
		expect(lists.mock.calls).toEqual(expect.arrayContaining([
			[beforeId, ".", ["added.ts"]], [afterId, ".", ["added.ts"]],
			[beforeId, "nested", ["child.ts"]], [afterId, "nested", ["child.ts"]],
		]));
		expect(reads).not.toHaveBeenCalled();
		const select = vi.fn().mockResolvedValueOnce("M nested/child.ts").mockResolvedValueOnce("M nested/child.ts")
			.mockResolvedValueOnce(undefined);
		const custom = vi.fn();
		await browseDiff({ ui: { select, custom } } as unknown as ExtensionCommandContext, "Run", view, () => true);
		expect(custom).toHaveBeenCalledTimes(2);
		expect(reads.mock.calls).toEqual([
			[beforeId, "nested", "old-child", "child.ts"], [afterId, "nested", "new-child", "child.ts"],
		]);
	});

	it("超过字节预算分批，超大单文件独占一批，保留 checkpoint 路径顺序", async () => {
		const paths = ["z", "a", "huge", "b"];
		const entries = paths.map((p) => file(p, p, (p === "huge" ? 20 : 5) * 1024 * 1024));
		const base = source();
		base.listTree = async () => entries;
		base.readBlob = async () => Buffer.from("短正文");
		const batches = vi.spyOn(SnapshotStore, "readBlobs");
		try {
			const diffs = await computeCheckpointDiff(base, {
				beforeManifestId: beforeId, afterManifestId: afterId, changedPaths: paths,
			});
			expect(diffs.map((diff) => diff.path)).toEqual(paths);
			for (const id of [beforeId, afterId]) {
				expect(batches.mock.calls.filter(([, manifest]) => manifest === id)
					.map(([, , requests]) => requests.map((r) => r.relativePath))).toEqual([["z"], ["a"], ["huge"], ["b"]]);
			}
		} finally {
			batches.mockRestore();
		}
	});

	it("空范围无需列树，损坏的正文在实际打开时报告错误", async () => {
		const base = source();
		const lists = vi.spyOn(base, "listTree");
		const request = { beforeManifestId: beforeId, afterManifestId: afterId, changedPaths: [] };
		expect(await computeCheckpointDiff(base, request)).toEqual([]);
		expect(lists).not.toHaveBeenCalled();
		vi.spyOn(base, "readBlob").mockRejectedValue(new Error("缺少 blob"));
		const view = await prepareCheckpointDiff(base, { ...request, changedPaths: ["added.ts"] });
		await expect(view.loadFile(view.files[0]!)).rejects.toThrow("缺少 blob");
	});

	it("按有效字节范围解码，保留 BOM，并将无效 UTF-8 视为二进制", async () => {
		const base = source();
		const read = vi.spyOn(base, "readBlob");
		const request = { beforeManifestId: beforeId, afterManifestId: afterId, changedPaths: ["added.ts"] };
		read.mockResolvedValueOnce(Buffer.from("\0\uFEFF新增\n\0").subarray(1, -1));
		expect((await computeCheckpointDiff(base, request))[0]?.diff).toBe("+1 \uFEFF新增");
		read.mockResolvedValueOnce(Uint8Array.of(0xc0, 0xaf));
		expect((await computeCheckpointDiff(base, request))[0]?.kind).toBe("binary");
	});

	it("匹配普通变更的 Pi 输出，包括换行、重复行、行号宽度与多段上下文", () => {
		const context = Array.from({ length: 18 }, (_, i) => i + "\n").join("");
		for (const [left, right] of [
			["", "\n\n"], ["abc", ""], ["a\r\n", "a\n"], ["a", "a\n"], ["a\na\nb\n", "a\nb\na\n"],
			[context, "A\n" + context + "B"], [context + "x\n" + context, context + "y\n" + context],
		]) {
			const expected = generateDiffString(left!, right!).diff;
			const actual = compareDiffText(left!, right!);
			expect(actual.diff).toBe(expected);
			expect(actual.additions).toBe(expected.split("\n").filter((line) => line.startsWith("+")).length);
			expect(actual.deletions).toBe(expected.split("\n").filter((line) => line.startsWith("-")).length);
		}
	});

	it("超出搜索预算只替换变化区间，整块统计在摘要中带标记", async () => {
		const base = source();
		const common = "相同\n".repeat(8);
		const block = (value: string) => common + (value + "\n").repeat(400) + common;
		vi.spyOn(base, "readBlob").mockImplementation(async (id) => Buffer.from(block(id === beforeId ? "甲" : "乙")));
		const view = await prepareCheckpointDiff(base, {
			beforeManifestId: beforeId, afterManifestId: afterId, changedPaths: ["modified.ts"],
		});
		const file = await view.loadFile(view.files[0]!);
		expect(file).toMatchObject({ simplified: true, additions: 400, deletions: 400 });
		expect(file.diff).toContain("-  9 甲");
		expect(file.diff).toContain("+408 乙");
		expect(await view.summary()).toBe(formatDiffSummary([file]));
		expect(await view.summary()).toContain("block replacement");
		expect(compareDiffText(common, "插入\n".repeat(800) + common)).toMatchObject({
			additions: 800, deletions: 0, simplified: false,
		});
	});

	it("格式化文件标签与非 TUI 摘要", async () => {
		const diffs = await computeCheckpointDiff(source(), {
			beforeManifestId: beforeId,
			afterManifestId: afterId,
			changedPaths: ["added.ts", "binary.dat"],
		});
		expect(buildFileLabel(diffs[0]!)).toBe("A added.ts  +2 -0");
		expect(buildFileLabel(diffs[1]!)).toBe("M binary.dat  (binary)");
		expect(formatDiffSummary(diffs)).toBe("2 file(s), +2 -0: added.ts, binary.dat");
		expect(sanitizeDisplayText("safe\x1b[31m red\x1b[0m\nnext")).toBe("safe red next");
		expect(buildFileLabel({ ...diffs[0]!, path: "src/\x1b[31mbad.ts" })).toBe("A src/bad.ts  +2 -0");
	});
});
