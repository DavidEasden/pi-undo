import { describe, expect, it } from "vitest";

import {
	buildFileLabel,
	computeCheckpointDiff,
	formatDiffSummary,
	sanitizeDisplayText,
	type DiffSource,
} from "../src/diff-view.ts";
import type { ManifestId, RestorePath, SnapshotManifest, SnapshotRoot } from "../src/model.ts";

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
