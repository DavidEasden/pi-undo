import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

class TreeQueryGitRunner extends GitRunner {
	treeQuery: { args: readonly string[]; options?: GitRunOptions } | undefined;

	override async run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
		if (args[0] === "ls-tree") this.treeQuery = { args, options };
		return super.run(args, options);
	}
}

// 单独测 Git 查询；不包含造数、capture、JS 解析，不设置墙钟门槛。
describe.skipIf(process.env.PI_UNDO_TREE_BENCHMARK !== "1")("tree 查询成本基准", () => {
	it("比较大小查询与 scope 密度", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-tree-query-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-tree-query-store-"));
		try {
			const paths = Array.from({ length: 10_001 }, (_, index) => `file-${String(index).padStart(5, "0")}.txt`);
			for (let start = 0; start < paths.length; start += 32) {
				await Promise.all(paths.slice(start, start + 32).map((path) => writeFile(join(root, path), path)));
			}
			const git = new TreeQueryGitRunner();
			const store = new SnapshotStore({ storeRoot, git });
			const manifest = await store.capture(await new RootDiscovery().discover(root));
			await store.listTree(manifest.manifestId, ".");
			const options = git.treeQuery!.options;
			const treeId = manifest.roots[0]!.treeId!;
			const cases = [
				{ name: "全量带大小", size: true, paths: undefined },
				{ name: "全量无大小", size: false, paths: undefined },
				{ name: "10001 个路径带大小", size: true, paths },
				{ name: "10001 个路径无大小", size: false, paths },
				{ name: "1 个路径带大小", size: true, paths: paths.slice(0, 1) },
				{ name: "256 个路径带大小", size: true, paths: paths.slice(0, 256) },
			];
			for (let sample = 1; sample <= 3; sample += 1) {
				for (const item of cases) {
					const started = performance.now();
					const result = await git.run([
						"ls-tree", "-r", "-z", ...(item.size ? ["-l"] : []), treeId,
						...(item.paths === undefined ? [] : ["--", ...item.paths.map((path) => `:(top,literal)${path}`)]),
					], options);
					const durationMs = performance.now() - started;
					expect(result.code).toBe(0);
					expect(result.stdout.split("\0").length - 1).toBe(item.paths?.length ?? paths.length);
					console.log(JSON.stringify({ benchmark: "tree-query", name: item.name, sample, durationMs, bytes: result.stdoutBytes.length }));
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 120_000);
});
