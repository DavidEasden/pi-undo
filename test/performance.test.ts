import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { RestoreEngine } from "../src/restore-engine.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

class CountingGitRunner extends GitRunner {
	readonly calls: string[][] = [];
	activeHashCalls = 0;
	maxActiveHashCalls = 0;

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		this.calls.push([...args]);
		const isHash = args.includes("hash-object");
		if (isHash) {
			this.activeHashCalls += 1;
			this.maxActiveHashCalls = Math.max(this.maxActiveHashCalls, this.activeHashCalls);
		}
		try {
			return await super.run(args, options);
		} finally {
			if (isHash) this.activeHashCalls -= 1;
		}
	}
}

describe("undo/redo restore performance", () => {
	it("四千文件 rollback snapshot 使用分块批量 Git 调用", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-capture-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-capture-perf-store-"));
		try {
			await mkdir(join(workspace, "src"));
			await Promise.all(Array.from({ length: 4_100 }, (_, index) => writeFile(
				join(workspace, "src", `file-${String(index).padStart(5, "0")}.txt`),
				`content ${index}\n`,
			)));
			const git = new CountingGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const topology = await discovery.discover(workspace);
			git.calls.length = 0;

			await store.capture(topology);

			expect(countCommand(git.calls, "hash-object")).toBeLessThanOrEqual(
				process.platform === "win32" ? 33 : 3,
			);
			expect(git.maxActiveHashCalls).toBeGreaterThanOrEqual(2);
			expect(git.maxActiveHashCalls).toBeLessThanOrEqual(4);
			expect(countCommand(git.calls, "update-index")).toBe(2);
			expect(countCommand(git.calls, "write-tree")).toBe(1);
			expect(countCommand(git.calls, "cat-file")).toBe(1);
			expect(git.calls.length).toBeLessThanOrEqual(52);

			await writeFile(join(workspace, "src", "file-00000.txt"), "changed\n");
			git.calls.length = 0;
			await store.capture(topology, ["src/file-00000.txt"]);
			expect(countCommand(git.calls, "hash-object")).toBe(1);
			expect(countCommand(git.calls, "update-index")).toBe(1);
			expect(git.calls.length).toBeLessThanOrEqual(14);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 120_000);

	it("一百零四文件 apply 批量读取 blob 且保留完整逻辑 WAL", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-apply-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-apply-perf-store-"));
		const journalRoot = await mkdtemp(join(tmpdir(), "pi-undo-apply-perf-journal-"));
		try {
			await mkdir(join(workspace, "src"));
			const scope = Array.from(
				{ length: 104 },
				(_, index) => `src/file-${String(index).padStart(3, "0")}.txt`,
			);
			await Promise.all(scope.map((path, index) => writeFile(join(workspace, path), `before ${index}\n`)));
			const git = new CountingGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const restore = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
			const topology = await discovery.discover(workspace);
			const target = await store.capture(topology);
			await Promise.all(scope.map((path, index) => writeFile(join(workspace, path), `after ${index}\n`)));
			const current = await store.capture(topology, scope);
			const plan = await restore.plan(current, target, scope);
			git.calls.length = 0;
			const journalPath = join(journalRoot, "mutations.jsonl");
			const journal = new MutationJournal(journalPath, "op-apply-performance");

			const result = await restore.apply(plan, target, {
				opId: "op-apply-performance",
				mutationJournal: journal,
			});

			expect(result.code).toBe("ok");
			expect(git.calls.length).toBeLessThanOrEqual(12);
			expect((await readFile(journalPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(104 * 6);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
			await rm(journalRoot, { recursive: true, force: true });
		}
	}, 120_000);

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
			expect(countCommand(git.calls, "ls-tree")).toBeLessThanOrEqual(2);
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
