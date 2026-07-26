import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { RestoreEngine } from "../src/restore-engine.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

class CountingGitRunner extends GitRunner {
	readonly calls: string[][] = [];

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		this.calls.push([...args]);
		return super.run(args, options);
	}
}

describe("undo/redo restore performance", () => {
	it("scoped restore 的 Git 调用数不随未改动文件线性增长", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-perf-store-"));
		try {
			await mkdir(join(workspace, "src"));
			await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(
				join(workspace, "src", `file-${String(index).padStart(4, "0")}.txt`),
				`before ${index}\n`,
			)));
			const git = new CountingGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const restore = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
			const topology = await discovery.discover(workspace);
			const before = await store.capture(topology);
			await writeFile(join(workspace, "src", "file-0000.txt"), "after\n");
			const current = await store.capture(topology);
			git.calls.length = 0;

			const plan = await restore.plan(current, before, ["src/file-0000.txt"]);
			const result = await restore.apply(plan, before);

			expect(result.code).toBe("ok");
			expect(countCommand(git.calls, "hash-object")).toBe(0);
			expect(countCommand(git.calls, "update-index")).toBe(0);
			expect(countCommand(git.calls, "write-tree")).toBe(0);
			expect(countCommand(git.calls, "ls-tree")).toBe(0);
			expect(countCommand(git.calls, "cat-file")).toBeLessThanOrEqual(12);
			expect(git.calls.length).toBeLessThanOrEqual(24);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 120_000);
});

function countCommand(calls: readonly string[][], command: string): number {
	return calls.filter((args) => args.includes(command)).length;
}
