import { lstat, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import type { NativeMetadataEntry, NativeMetadataPort } from "../src/native-metadata.ts";
import { RestoreEngine } from "../src/restore-engine.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { createGitRepo, createNestedRepo } from "./fixtures.ts";

class CountingGitRunner extends GitRunner {
	readonly calls: string[][] = [];
	activeHashCalls = 0;
	maxActiveHashCalls = 0;
	failNextWriteTree = false;

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		this.calls.push([...args]);
		if (this.failNextWriteTree && args.includes("write-tree")) {
			this.failNextWriteTree = false;
			throw new Error("injected write-tree failure");
		}
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

class FailingRootGitRunner extends CountingGitRunner {
	failRoot: string | undefined;

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		if (this.failRoot !== undefined && options.cwd === this.failRoot && args.includes("write-tree")) {
			this.failRoot = undefined;
			throw new Error("injected root failure");
		}
		return super.run(args, options);
	}
}

class RootConcurrencyGitRunner extends CountingGitRunner {
	activeRootCaptures = 0;
	maxActiveRootCaptures = 0;

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		if (args[0] !== "read-tree") return super.run(args, options);
		this.activeRootCaptures += 1;
		this.maxActiveRootCaptures = Math.max(this.maxActiveRootCaptures, this.activeRootCaptures);
		try {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
			return await super.run(args, options);
		} finally {
			this.activeRootCaptures -= 1;
		}
	}
}

class RecordingMetadataPort implements NativeMetadataPort {
	readonly calls: string[][] = [];
	failOnIgnoredBatch: number | undefined;
	private ignoredBatches = 0;

	resetIgnoredBatches(): void {
		this.ignoredBatches = 0;
	}

	async inspect(
		workspaceRoot: string,
		paths: readonly string[],
		_requestDirectory: string,
	): Promise<readonly NativeMetadataEntry[] | undefined> {
		this.calls.push([...paths]);
		if (paths.length > 0 && paths.every((path) => path.startsWith("ignored/"))) {
			this.ignoredBatches += 1;
			if (this.ignoredBatches === this.failOnIgnoredBatch) return undefined;
		}
		return Promise.all(paths.map(async (path): Promise<NativeMetadataEntry> => {
			const metadata = await lstat(join(workspaceRoot, ...path.split("/")), { bigint: true }).catch(() => null);
			if (metadata === null) return { path, kind: "absent" };
			return {
				path,
				kind: metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "other",
				dev: metadata.dev,
				ino: metadata.ino,
				mode: metadata.mode,
				size: metadata.size,
				mtimeNs: metadata.mtimeNs,
				ctimeNs: metadata.ctimeNs,
			};
		}));
	}
}

describe("undo/redo restore performance", () => {
	it("独立 nested roots 并行 capture 且保持 manifest 顺序", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-root-parallel-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-root-parallel-store-"));
		try {
			await createGitRepo(workspace);
			await Promise.all([
				createNestedRepo(workspace, "nested-a"),
				createNestedRepo(workspace, "nested-b"),
				createNestedRepo(workspace, "nested-c"),
			]);
			const git = new RootConcurrencyGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const topology = await discovery.discover(workspace);
			git.calls.length = 0;

			const manifest = await store.capture(topology);

			expect(git.maxActiveRootCaptures).toBeGreaterThanOrEqual(2);
			expect(git.maxActiveRootCaptures).toBeLessThanOrEqual(4);
			expect(git.maxActiveHashCalls).toBeLessThanOrEqual(16);
			expect(manifest.roots.map((root) => root.relativeRoot))
				.toEqual(topology.roots.map((root) => root.relativeRoot));
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	});

	it("并行 multi-root 失败不发布任何 root fingerprint cache", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-root-failure-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-root-failure-store-"));
		try {
			await createGitRepo(workspace);
			const [nestedA] = await Promise.all([
				createNestedRepo(workspace, "nested-a"),
				createNestedRepo(workspace, "nested-b"),
			]);
			const git = new FailingRootGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const topology = await discovery.discover(workspace);
			git.failRoot = await realpath(nestedA.root);

			await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
			git.calls.length = 0;
			await store.capture(topology);

			expect(countCommand(git.calls, "hash-object")).toBe(topology.roots.length);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	});

	it("大量 ignored-present 叶子使用有界 metadata batches", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-ignored-batch-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-ignored-batch-store-"));
		try {
			await mkdir(join(workspace, "ignored"));
			await writeFile(join(workspace, ".gitignore"), "ignored/\n");
			await Promise.all(Array.from({ length: 2_100 }, (_, index) =>
				writeFile(join(workspace, "ignored", `file-${index}.txt`), `${index}\n`)));
			const nativeMetadata = new RecordingMetadataPort();
			const discovery = new RootDiscovery();
			const store = new SnapshotStore({ storeRoot, discovery, nativeMetadata });
			const topology = await discovery.discover(workspace);

			const manifest = await store.capture(topology);

			expect(manifest.roots[0]?.ignoredPresentPaths).toHaveLength(2_100);
			const ignoredBatches = nativeMetadata.calls.filter((paths) =>
				paths.length > 0 && paths.every((path) => path.startsWith("ignored/")));
			expect(ignoredBatches.map((paths) => paths.length)).toEqual([1_024, 1_024, 52]);

			nativeMetadata.failOnIgnoredBatch = 2;
			nativeMetadata.resetIgnoredBatches();
			await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("四千文件 rollback snapshot 使用分块批量 Git 调用", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-capture-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-capture-perf-store-"));
		try {
			await mkdir(join(workspace, "src"));
			await Promise.all(Array.from({ length: 4_100 }, (_, index) => writeFile(
				join(workspace, "src", `file-${String(index).padStart(5, "0")}.txt`),
				`content ${index}\n`,
			)));
			// 缓存采用 Git 式 racily-clean 窗口；基线文件必须早于验证时刻。
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
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

			git.calls.length = 0;
			await store.capture(topology);
			expect(countCommand(git.calls, "hash-object")).toBe(0);
			expect(countCommand(git.calls, "update-index")).toBe(2);

			await writeFile(join(workspace, "src", "file-00000.txt"), "changed\n");
			git.calls.length = 0;
			await store.capture(topology);
			expect(countCommand(git.calls, "hash-object")).toBe(1);
			expect(countCommand(git.calls, "update-index")).toBe(2);
			expect(git.calls.length).toBeLessThanOrEqual(18);

			git.calls.length = 0;
			await store.capture(topology, ["src/file-00000.txt"]);
			expect(countCommand(git.calls, "hash-object")).toBe(1);
			expect(countCommand(git.calls, "update-index")).toBe(1);
			expect(git.calls.length).toBeLessThanOrEqual(14);

			await unlink(join(workspace, "src", "file-00000.txt"));
			await writeFile(join(workspace, "src", "file-00000.txt"), "changed\n");
			git.calls.length = 0;
			await store.capture(topology);
			expect(countCommand(git.calls, "hash-object")).toBe(1);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 120_000);

	it("失败的 capture 不发布 fingerprint cache", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-cache-failure-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-cache-failure-store-"));
		try {
			await writeFile(join(workspace, "file.txt"), "before\n");
			const git = new CountingGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const topology = await discovery.discover(workspace);
			await store.capture(topology);
			await writeFile(join(workspace, "file.txt"), "after\n");

			git.failNextWriteTree = true;
			await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
			git.calls.length = 0;
			await store.capture(topology);
			expect(countCommand(git.calls, "hash-object")).toBe(1);

			git.calls.length = 0;
			await store.capture(topology);
			expect(countCommand(git.calls, "hash-object")).toBe(0);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	});

	it("两千五百文件 plan 按字节上限而非固定条数切分 blob 批次", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-plan-batch-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-plan-batch-store-"));
		try {
			await mkdir(join(workspace, "src"));
			const scope = Array.from(
				{ length: 2_500 },
				(_, index) => `src/file-${String(index).padStart(5, "0")}.txt`,
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
			git.calls.length = 0;

			const plan = await restore.plan(current, target, scope);

			expect(plan.writePaths).toHaveLength(2_500);
			// 5000 个小 blob（current + target 两侧）远未触及 16MB 字节上限，
			// 因此批次数应由字节预算决定，不应退化成每 256 条切一批。
			const blobBatches = git.calls.filter(
				(args) => args.includes("cat-file") && args.includes("--batch"),
			).length;
			expect(blobBatches).toBeLessThanOrEqual(process.platform === "win32" ? 20 : 4);
			expect(countCommand(git.calls, "cat-file")).toBeLessThanOrEqual(
				process.platform === "win32" ? 24 : 8,
			);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 180_000);

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

	it("一百文件 delete apply 使用 batch WAL 并恢复为空状态", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-delete-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-delete-perf-store-"));
		const journalRoot = await mkdtemp(join(tmpdir(), "pi-undo-delete-perf-journal-"));
		try {
			const git = new CountingGitRunner();
			const discovery = new RootDiscovery(git);
			const store = new SnapshotStore({ storeRoot, git, discovery });
			const restore = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
			const topology = await discovery.discover(workspace);
			const target = await store.capture(topology);
			await mkdir(join(workspace, "src"));
			const files = Array.from(
				{ length: 100 },
				(_, index) => `src/file-${String(index).padStart(3, "0")}.txt`,
			);
			await Promise.all(files.map((path, index) => writeFile(join(workspace, path), `created ${index}\n`)));
			const scope = ["src", ...files];
			const current = await store.capture(topology, scope);
			const plan = await restore.plan(current, target, scope);
			git.calls.length = 0;
			const journalPath = join(journalRoot, "mutations.jsonl");
			const journal = new MutationJournal(journalPath, "op-delete-performance");

			const result = await restore.apply(plan, target, {
				opId: "op-delete-performance",
				mutationJournal: journal,
			});

			expect(result.code).toBe("ok");
			await expect(readFile(join(workspace, files[0]!))).rejects.toMatchObject({ code: "ENOENT" });
			expect(git.calls.length).toBeLessThanOrEqual(12);
			expect((await readFile(journalPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(100 * 6);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
			await rm(journalRoot, { recursive: true, force: true });
		}
	}, 120_000);

	it("五千普通文件 delete-only restore 使用 native batch", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-undo-delete-native-perf-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-delete-native-perf-store-"));
		const journalRoot = await mkdtemp(join(tmpdir(), "pi-undo-delete-native-perf-journal-"));
		try {
			const files = Array.from(
				{ length: 5_000 },
				(_, index) => `file-${String(index).padStart(5, "0")}.txt`,
			);
			await Promise.all(files.map((path, index) => writeFile(join(workspace, path), `content ${index}\n`)));
			const discovery = new RootDiscovery();
			const store = new SnapshotStore({ storeRoot, discovery });
			const restore = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
			const topology = await discovery.discover(workspace);
			const before = await store.capture(topology);
			await Promise.all(files.map((path) => unlink(join(workspace, path))));
			const target = await store.capture(topology, files);
			await Promise.all(files.map((path, index) => writeFile(join(workspace, path), `content ${index}\n`)));
			const plan = await restore.plan(before, target, files);
			await restore.prepareDurableRestore(before, target, files);
			const result = await restore.apply(plan, target, {
				opId: "delete-native-performance",
				mutationJournal: new MutationJournal(
					join(journalRoot, "mutations.jsonl"),
					"delete-native-performance",
				),
				deferDurability: true,
			});
			expect(plan.deletePaths).toHaveLength(5_000);
			expect(plan.writePaths).toHaveLength(0);
			expect(result).toMatchObject({ code: "ok", verifiedPaths: 5_000, totalPaths: 5_000 });
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
			await rm(journalRoot, { recursive: true, force: true });
		}
	}, 180_000);

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
