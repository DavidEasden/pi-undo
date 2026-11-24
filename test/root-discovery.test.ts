import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitRunError, GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { createOperationScope, runWithOperationContext } from "../src/operation-context.ts";
import type { NativeRepositoryCandidate } from "../src/native-directory-scan.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { WorkspaceLock, workspaceLockPath } from "../src/workspace-lock.ts";
import {
	createGitRepo,
	createLocalSubmodule,
	createNestedRepo,
	readGitMetadata,
	runGit,
	writeFile as writeFixtureFile,
} from "./fixtures.ts";

const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-discovery-"));
	temporaryRoots.push(root);
	return root;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!await predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("等待测试条件超时");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class TerminatingGitRunner extends GitRunner {
	override run(): Promise<GitRunResult> {
		return Promise.reject(new GitRunError("git_termination_failed", "注入的未确认终止"));
	}
}

class RecordingGitRunner extends GitRunner {
	readonly calls: string[][] = [];

	override async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
		this.calls.push([...args]);
		return super.run(args, options);
	}
}


describe("RootDiscovery", () => {
	it("为非 Git 工作区创建 synthetic outer root", async () => {
		const root = await temporaryRoot();
		await writeFixtureFile(root, "plain.txt", "plain\n");

		const topology = await new RootDiscovery().discover(root);

		expect(topology.roots).toEqual([
			expect.objectContaining({ relativeRoot: ".", parentRoot: null, state: "active", treeId: null }),
		]);
		expect(topology.workspaceIdentity).toContain("pi-undo-discovery-");
	});

	it("识别 Git outer root", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);

		const topology = await new RootDiscovery().discover(repository.root);

		expect(topology.roots).toHaveLength(1);
		expect(topology.roots[0]).toEqual(
			expect.objectContaining({ relativeRoot: ".", parentRoot: null, state: "active" }),
		);
		expect(topology.roots[0].treeId).toMatch(/^[0-9a-f]{40}$/);
	});

	it("active repository discovery 在一次 rev-parse 中读取 HEAD", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		const git = new RecordingGitRunner();

		await new RootDiscovery(git).discover(repository.root);

		const revParseCalls = git.calls.filter((args) => args.includes("rev-parse"));
		expect(revParseCalls).toHaveLength(1);
		expect(revParseCalls[0]).toEqual(expect.arrayContaining([
			"--show-toplevel", "--git-dir", "--git-common-dir", "HEAD",
		]));
	});

	it("发现两层 nested repository 并建立最近父级", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await createNestedRepo(outer.root, "packages/child");
		await createNestedRepo(outer.root, "packages/child/deeper");

		const topology = await new RootDiscovery().discover(outer.root);

		expect(topology.roots.map((root) => [root.relativeRoot, root.parentRoot])).toEqual([
			[".", null],
			["packages/child", "."],
			["packages/child/deeper", "packages/child"],
		]);
	});

	it("父仓库 ignore 不会隐藏 nested repository", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await writeFixtureFile(outer.root, ".gitignore", "ignored-child/\n");
		await createNestedRepo(outer.root, "ignored-child");

		const topology = await new RootDiscovery().discover(outer.root);

		expect(topology.roots.map((root) => root.relativeRoot)).toContain("ignored-child");
	});

	it("不跟随 workspace 内的 symlink 目录", async () => {
		const outer = await createGitRepo();
		const external = await createGitRepo();
		temporaryRoots.push(outer.root, external.root);
		await symlink(external.root, join(outer.root, "linked-repository"), "dir");

		const topology = await new RootDiscovery().discover(outer.root);

		expect(topology.roots.map((root) => root.relativeRoot)).not.toContain("linked-repository");
	});

	it("gitlink 的已初始化、未初始化与损坏状态可区分", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const active = await createLocalSubmodule(outer.root, "modules/active");
		const missing = await createLocalSubmodule(outer.root, "modules/missing");
		const broken = await createLocalSubmodule(outer.root, "modules/broken");
		temporaryRoots.push(active.sourceRoot, missing.sourceRoot, broken.sourceRoot);
		await rm(missing.root, { recursive: true, force: true });
		await rm(join(broken.root, ".git"), { force: true });

		const topology = await new RootDiscovery().discover(outer.root);
		const states = new Map(topology.roots.map((root) => [root.relativeRoot, root.state]));

		expect(states.get("modules/active")).toBe("active");
		expect(states.get("modules/missing")).toBe("uninitialized");
		expect(states.get("modules/broken")).toBe("broken");
	});

	it("gitlink 空目录骨架（如 git worktree 遗留）按未初始化处理，含文件才算 broken", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const empty = await createLocalSubmodule(outer.root, "modules/empty-skeleton");
		const nested = await createLocalSubmodule(outer.root, "modules/nested-skeleton");
		temporaryRoots.push(empty.sourceRoot, nested.sourceRoot);
		await rm(join(empty.root, ".git"), { force: true });
		await rm(empty.root, { recursive: true, force: true });
		await mkdir(empty.root, { recursive: true });
		await rm(nested.root, { recursive: true, force: true });
		await mkdir(join(nested.root, "left", "right"), { recursive: true });

		const topology = await new RootDiscovery().discover(outer.root);
		const states = new Map(topology.roots.map((root) => [root.relativeRoot, root.state]));

		expect(states.get("modules/empty-skeleton")).toBe("uninitialized");
		expect(states.get("modules/nested-skeleton")).toBe("uninitialized");
	});

	it("失效 gitdir 指针的 worktree 按未初始化处理，不产生 broken root", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		// 模拟项目从其他机器搬移：.git 指针指向本机不存在的 gitdir。
		await writeFixtureFile(outer.root, ".worktrees/migrated/src/main.py", "print('stale')\n");
		await writeFixtureFile(
			outer.root,
			".worktrees/migrated/.git",
			"gitdir: /nonexistent/.git/worktrees/migrated\n",
		);

		const topology = await new RootDiscovery().discover(outer.root);
		const states = new Map(topology.roots.map((root) => [root.relativeRoot, root.state]));

		expect(states.get(".worktrees/migrated")).toBe("uninitialized");
		expect([...states.values()]).not.toContain("broken");
	});

	it("有效 git worktree 仍识别为 active root，指针目标存在但非 gitdir 仍为 broken", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await runGit(outer.root, ["worktree", "add", ".worktrees/live", "-b", "live"]);
		await writeFixtureFile(outer.root, "junk/garbage/.git", "not a worktree pointer\n");
		await mkdir(join(outer.root, "junk", "plain-directory"), { recursive: true });
		await writeFixtureFile(
			outer.root,
			"junk/points-to-plain/.git",
			`gitdir: ${join(outer.root, "junk", "plain-directory")}\n`,
		);

		const topology = await new RootDiscovery().discover(outer.root);
		const states = new Map(topology.roots.map((root) => [root.relativeRoot, root.state]));

		expect(states.get(".worktrees/live")).toBe("active");
		expect(states.get("junk/garbage")).toBe("broken");
		expect(states.get("junk/points-to-plain")).toBe("broken");
	});

	it("initialized submodule 合并父 index 的 gitlinkOid，gitlink 删除会改变 fingerprint", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/active");
		temporaryRoots.push(child.sourceRoot);
		const discovery = new RootDiscovery();

		const before = await discovery.discover(outer.root);
		const childBefore = before.roots.find((root) => root.relativeRoot === "modules/active");
		const stage = await runGit(outer.root, ["ls-files", "--stage", "--", "modules/active"]);
		const expectedOid = stage.trim().split(/\s+/)[1];
		await runGit(outer.root, ["rm", "--cached", "--", "modules/active"]);
		const after = await discovery.discover(outer.root);

		expect(childBefore?.state).toBe("active");
		expect(childBefore?.gitlinkOid).toBe(expectedOid);
		expect(after.roots.find((root) => root.relativeRoot === "modules/active")?.gitlinkOid).toBeUndefined();
		expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	it("RootDiscovery 清除继承的 Git repository 与 index 环境", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/missing");
		temporaryRoots.push(child.sourceRoot);
		await rm(child.root, { recursive: true, force: true });
		const previousIndex = process.env.GIT_INDEX_FILE;
		const previousDirectory = process.env.GIT_DIR;
		process.env.GIT_INDEX_FILE = join(outer.root, "missing-index");
		process.env.GIT_DIR = join(outer.root, "missing-git-dir");
		try {
			const topology = await new RootDiscovery().discover(outer.root);
			expect(topology.roots.find((root) => root.relativeRoot === "modules/missing")?.state)
				.toBe("uninitialized");
		} finally {
			if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = previousIndex;
			if (previousDirectory === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = previousDirectory;
		}
	});

	it("restore-pre 在可信纯文件变化时复用 topology，并前后复核事件游标", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		const scan = vi.fn(async () => ({
			directories: 64,
			repositories: [],
			changeSequence: 10,
			changeInstance: "helper-1",
		}));
		const changesSince = vi.fn(async () => ({
			files: ["src/changed.ts"],
			directories: [],
			trusted: true,
			sequence: 11,
			instance: "helper-1",
		}));
		const discovery = new RootDiscovery(new GitRunner(), { scan, changesSince });
		const original = await discovery.discover(repository.root);

		const restored = await discovery.discover(repository.root, "restore-pre");

		expect(scan).toHaveBeenCalledOnce();
		expect(changesSince).toHaveBeenCalledTimes(2);
		expect(restored.roots.map(({ relativeRoot, parentRoot, state, gitlinkOid }) =>
			({ relativeRoot, parentRoot, state, gitlinkOid }))).toEqual(
			original.roots.map(({ relativeRoot, parentRoot, state, gitlinkOid }) =>
				({ relativeRoot, parentRoot, state, gitlinkOid })),
		);
	});

	it("多根恢复限量并行核验仓库和 index，保持拓扑及完整发现结果一致", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const repositories: NativeRepositoryCandidate[] = [];
		for (let index = 0; index < 5; index += 1) {
			const path = `packages/child-${index}`;
			const child = await createNestedRepo(outer.root, path);
			const metadata = await lstat(child.root, { bigint: true });
			repositories.push({ path, dev: metadata.dev, ino: metadata.ino });
		}
		const scan = vi.fn(async () => ({ directories: 64, repositories, changeSequence: 10, changeInstance: "helper-1" }));
		const changesSince = vi.fn(async () => ({ files: [], directories: [], trusted: true, sequence: 11, instance: "helper-1" }));
		const git = new GitRunner();
		const discovery = new RootDiscovery(git, { scan, changesSince });
		const original = await discovery.discover(outer.root);
		const run = git.run.bind(git);
		const active = { "rev-parse": 0, "ls-files": 0 };
		const maximum = { "rev-parse": 0, "ls-files": 0 };
		vi.spyOn(git, "run").mockImplementation(async (args, options) => {
			const command = args.includes("rev-parse") ? "rev-parse" : args.includes("ls-files") ? "ls-files" : undefined;
			if (command === undefined) return run(args, options);
			active[command] += 1;
			maximum[command] = Math.max(maximum[command], active[command]);
			try {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return await run(args, options);
			} finally { active[command] -= 1; }
		});

		const restored = await discovery.discover(outer.root, "restore-pre");

		expect(restored).toEqual(original);
		expect(scan).toHaveBeenCalledOnce();
		expect(changesSince).toHaveBeenCalledTimes(2);
		for (const count of Object.values(maximum)) {
			expect(count).toBeGreaterThan(1);
			expect(count).toBeLessThanOrEqual(4);
		}
		expect(active).toEqual({ "rev-parse": 0, "ls-files": 0 });
		maximum["ls-files"] = 0;
		expect(await discovery.discover(outer.root, "restore-post")).toEqual(original);
		expect(maximum["ls-files"]).toBeGreaterThan(1);
		expect(maximum["ls-files"]).toBeLessThanOrEqual(4);
	});

	it.each(["rev-parse", "ls-files"])("多根 %s 失败时等待本批读取结束且不启动下一批", async (command) => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const repositories: NativeRepositoryCandidate[] = [];
		for (let index = 0; index < 4; index += 1) {
			const path = `child-${index}`;
			const child = await createNestedRepo(outer.root, path);
			const metadata = await lstat(child.root, { bigint: true });
			repositories.push({ path, dev: metadata.dev, ino: metadata.ino });
		}
		const git = new GitRunner();
		const discovery = new RootDiscovery(git, {
			scan: async () => ({ directories: 64, repositories, changeSequence: 10, changeInstance: "helper-1" }),
			changesSince: async () => ({ files: [], directories: [], trusted: true, sequence: 11, instance: "helper-1" }),
		});
		await discovery.discover(outer.root);
		const run = git.run.bind(git);
		let started = 0;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		vi.spyOn(git, "run").mockImplementation(async (args, options) => {
			if (args.includes(command)) {
				started += 1;
				if (started === 1) throw new GitRunError("git_termination_failed", "注入的未确认终止");
				await pending;
			}
			return run(args, options);
		});
		let finished = false;
		const result = discovery.discover(outer.root, "restore-pre").catch((error: unknown) => error)
			.finally(() => { finished = true; });
		try {
			await waitUntil(() => started === 4);
			expect(finished).toBe(false);
		} finally { release(); }
		expect(await result).toMatchObject({ code: "git_termination_failed" });
		expect(started).toBe(4);
	});

	it.each([
		{ label: "目录变化", files: [], directories: ["new-directory"], trusted: true },
		{ label: ".git marker 变化", files: ["nested/.git"], directories: [], trusted: true },
		{ label: "事件不可信", files: [], directories: [], trusted: false },
	])("restore-pre 遇到$label时执行完整扫描", async ({ files, directories, trusted }) => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		const scan = vi.fn(async () => ({
			directories: 64,
			repositories: [],
			changeSequence: 10,
			changeInstance: "helper-1",
		}));
		const changesSince = vi.fn(async () => ({
			files,
			directories,
			trusted,
			sequence: 11,
			instance: "helper-1",
		}));
		const discovery = new RootDiscovery(new GitRunner(), { scan, changesSince });
		await discovery.discover(repository.root);

		await discovery.discover(repository.root, "restore-pre");

		expect(scan).toHaveBeenCalledTimes(2);
	});

	it("restore-pre 检查期间出现目录事件时回退完整扫描", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		const scan = vi.fn(async () => ({
			directories: 64,
			repositories: [],
			changeSequence: 10,
			changeInstance: "helper-1",
		}));
		let query = 0;
		const changesSince = vi.fn(async () => {
			query += 1;
			return query === 1
				? { files: [], directories: [], trusted: true, sequence: 11, instance: "helper-1" }
				: { files: [], directories: ["new-directory"], trusted: true, sequence: 12, instance: "helper-1" };
		});
		const discovery = new RootDiscovery(new GitRunner(), { scan, changesSince });
		await discovery.discover(repository.root);

		await discovery.discover(repository.root, "restore-pre");

		expect(changesSince).toHaveBeenCalledTimes(2);
		expect(scan).toHaveBeenCalledTimes(2);
	});

	it("restore-pre 对包含 gitlink 的 topology 保留完整扫描", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await createLocalSubmodule(outer.root, "modules/child");
		const scan = vi.fn(async () => ({
			directories: 64,
			repositories: [],
			changeSequence: 10,
			changeInstance: "helper-1",
		}));
		const changesSince = vi.fn(async () => ({
			files: [], directories: [], trusted: true, sequence: 11, instance: "helper-1",
		}));
		const discovery = new RootDiscovery(new GitRunner(), { scan, changesSince });
		const topology = await discovery.discover(outer.root);
		expect(topology.roots.some((root) => root.gitlinkOid !== undefined)).toBe(true);

		await discovery.discover(outer.root, "restore-pre");

		expect(scan).toHaveBeenCalledTimes(2);
		expect(changesSince).not.toHaveBeenCalled();
	});

	it("存在无效 .git marker 时记录 broken root，而不是静默降级 synthetic", async () => {
		const root = await temporaryRoot();
		await writeFile(join(root, ".git"), "gitdir: missing-git-directory\n");

		const topology = await new RootDiscovery().discover(root);

		expect(topology.roots).toEqual([
			expect.objectContaining({ relativeRoot: ".", parentRoot: null, state: "broken", treeId: null }),
		]);
	});

	it("fixture 可以读取 linked submodule 的真实 Git metadata", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const active = await createLocalSubmodule(outer.root, "modules/active");
		temporaryRoots.push(active.sourceRoot);

		const metadata = await readGitMetadata(active.root);

		expect(metadata.head.length).toBeGreaterThan(0);
		expect(metadata.refs).toContain("HEAD");
	});

	it("拓扑变化会改变 fingerprint", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const discovery = new RootDiscovery();
		const before = await discovery.discover(outer.root);
		const nested = await createNestedRepo(outer.root, "new-root");
		const afterAdd = await discovery.discover(outer.root);
		await rm(join(nested.root, ".git"), { recursive: true, force: true });
		const afterRemove = await discovery.discover(outer.root);

		expect(afterAdd.fingerprint).not.toBe(before.fingerprint);
		expect(afterRemove.fingerprint).not.toBe(afterAdd.fingerprint);
	});

	it("已取消的 context 立即抛出 operation_cancelled", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const scope = createOperationScope();
		scope.cancel();
		try {
			await expect(runWithOperationContext(scope.context, () => new RootDiscovery().discover(outer.root)))
				.rejects.toMatchObject({ code: "operation_cancelled" });
		} finally {
			scope.dispose();
		}
	});

	it("扫描循环中的取消会中断遍历并重抛，而不是当成不可读目录继续", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await mkdir(join(outer.root, "packages", "child", "deeper"), { recursive: true });
		const parent = new AbortController();
		const scope = createOperationScope({
			signal: parent.signal,
			onProgress: (phase) => {
				if (phase === "scan_directories") parent.abort();
			},
		});
		try {
			await expect(runWithOperationContext(scope.context, () => new RootDiscovery().discover(outer.root)))
				.rejects.toMatchObject({ code: "operation_cancelled" });
		} finally {
			scope.dispose();
		}
	});

	it("在遍历中报告可读阶段", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await createNestedRepo(outer.root, "packages/child");
		const phases: string[] = [];
		const scope = createOperationScope({ onProgress: (phase) => phases.push(phase) });
		try {
			await runWithOperationContext(scope.context, () => new RootDiscovery().discover(outer.root));
		} finally {
			scope.dispose();
		}

		expect(phases).toContain("discover_roots:unspecified");
		expect(phases.some((phase) => phase.startsWith("scan_directories:"))).toBe(true);
		expect(phases).toContain("discover_gitlinks");
	});

	it("外层 Git 检查失败时，仍等待并行的目录扫描结束再报告错误", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const git = new TerminatingGitRunner();
		const inspect = vi.spyOn(git, "run");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const scan = vi.fn(async () => { await pending; return { directories: 1, repositories: [] }; });
		let finished = false;
		const result = new RootDiscovery(git, { scan }).discover(outer.root).catch((error: unknown) => error)
			.finally(() => { finished = true; });
		try {
			await waitUntil(() => inspect.mock.calls.length > 0);
			expect(scan).toHaveBeenCalledOnce();
			expect(finished).toBe(false);
		} finally { release(); }
		expect(await result).toMatchObject({ code: "git_termination_failed" });
	});
});

describe("WorkspaceLock", () => {
	it("显式 lease 在 release 前持续阻止同 workspace 的其他实例", async () => {
		const root = await temporaryRoot();
		const firstLock = new WorkspaceLock({ lockRoot: join(root, "locks"), retryMs: 5 });
		const secondLock = new WorkspaceLock({ lockRoot: join(root, "locks"), retryMs: 5 });
		const firstLease = await firstLock.acquire("workspace-lease");
		let secondAcquired = false;
		const second = secondLock.acquire("workspace-lease").then(async (lease) => {
			secondAcquired = true;
			await lease.release();
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(secondAcquired).toBe(false);
		await firstLease.release();
		await second;
		expect(secondAcquired).toBe(true);
	});

	it("同一 workspace 在进程内严格串行", async () => {
		const root = await temporaryRoot();
		const firstLock = new WorkspaceLock({ lockRoot: join(root, "locks"), retryMs: 5 });
		const secondLock = new WorkspaceLock({ lockRoot: join(root, "locks"), retryMs: 5 });
		let active = 0;
		let maximum = 0;

		await Promise.all(
			[firstLock, secondLock, firstLock].map((lock, value) => lock.withLock("workspace-a", async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 15));
				active -= 1;
				return value;
			})),
		);

		expect(maximum).toBe(1);
	});

	it("不同 WorkspaceLock 实例与 lock root 仍共享进程内 identity mutex", async () => {
		const root = await temporaryRoot();
		const firstLock = new WorkspaceLock({ lockRoot: join(root, "locks-a"), retryMs: 5 });
		const secondLock = new WorkspaceLock({ lockRoot: join(root, "locks-b"), retryMs: 5 });
		let active = 0;
		let maximum = 0;

		await Promise.all([firstLock, secondLock].map((lock) => lock.withLock("workspace-shared", async () => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active -= 1;
		})));

		expect(maximum).toBe(1);
	});

	it("双 stale reclaimer 不会删除新 owner 或同时进入临界区", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-stale-race";
		const lockDirectory = workspaceLockPath(lockRoot, identity);
		const gatePath = join(root, "release-gate");
		const logPath = join(root, "entries.log");
		const workerPath = join(root, "lock-worker.mjs");
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
			pid: 999_999_999,
			processStartedAt: Date.now() - 60_000,
			workspaceIdentity: identity,
			nonce: "stale-owner",
			leaseExpiresAt: Date.now() - 1,
		}));
		const moduleUrl = pathToFileURL(join(process.cwd(), "src", "workspace-lock.ts")).href;
		await writeFile(workerPath, `
			import { appendFile, access } from "node:fs/promises";
			import { WorkspaceLock } from ${JSON.stringify(moduleUrl)};
			const [lockRoot, identity, gatePath, logPath] = process.argv.slice(2);
			const lock = new WorkspaceLock({ lockRoot, leaseMs: 100, retryMs: 2, acquireTimeoutMs: 5_000 });
			await lock.withLock(identity, async () => {
				await appendFile(logPath, String(process.pid) + "\\n");
				while (true) {
					try { await access(gatePath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
				}
			});
		`);
		const workers = Array.from({ length: 8 }, () => executeFile(
			process.execPath,
			["--experimental-strip-types", workerPath, lockRoot, identity, gatePath, logPath],
		));
		await waitUntil(async () => {
			try {
				return (await readFile(logPath, "utf8")).length > 0;
			} catch {
				return false;
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		const entriesBeforeRelease = (await readFile(logPath, "utf8")).trim().split("\n");
		await writeFile(gatePath, "release\n");
		await Promise.all(workers);

		expect(entriesBeforeRelease).toHaveLength(1);
	});

	it("仅在失主且租约过期时回收 stale lock", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-stale";
		const lockDirectory = workspaceLockPath(lockRoot, identity);
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
			pid: 999_999_999,
			processStartedAt: 0,
			workspaceIdentity: identity,
			nonce: "stale-owner",
			leaseExpiresAt: Date.now() - 1,
		}));

		const lock = new WorkspaceLock({ lockRoot, retryMs: 5, leaseMs: 50 });
		await expect(lock.withLock(identity, async () => "acquired")).resolves.toBe("acquired");
	});

	it("存活 owner 即使 lease 过期也不回收", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-live-owner";
		const lockDirectory = workspaceLockPath(lockRoot, identity);
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
			pid: process.pid,
			processStartedAt: 0,
			workspaceIdentity: identity,
			nonce: "live-owner",
			leaseExpiresAt: Date.now() - 1,
		}));

		const lock = new WorkspaceLock({ lockRoot, retryMs: 5, leaseMs: 10, acquireTimeoutMs: 30 });
		await expect(lock.withLock(identity, async () => "unexpected")).rejects.toMatchObject({
			code: "lock_timeout",
		});
	});

	it("无 owner 的过期初始化目录可以安全回收", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-incomplete";
		const lockDirectory = workspaceLockPath(lockRoot, identity);
		await mkdir(lockDirectory, { recursive: true });
		await utimes(lockDirectory, 0, 0);

		const lock = new WorkspaceLock({ lockRoot, retryMs: 5, leaseMs: 10, acquireTimeoutMs: 30 });
		await expect(lock.withLock(identity, async () => "acquired")).resolves.toBe("acquired");
	});

	it("损坏或部分 owner 即使过期也 fail-closed", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-corrupt-owner";
		const lockDirectory = workspaceLockPath(lockRoot, identity);
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "owner.json"), "{\"pid\":");
		await utimes(lockDirectory, 0, 0);

		const lock = new WorkspaceLock({ lockRoot, retryMs: 5, leaseMs: 10, acquireTimeoutMs: 30 });
		await expect(lock.withLock(identity, async () => "unexpected")).rejects.toMatchObject({
			code: "lock_timeout",
		});
		expect(await readFile(join(lockDirectory, "owner.json"), "utf8")).toBe("{\"pid\":");
	});

	it("频繁接管下的 acquire/release 不产生 lock_compromised", async () => {
		const root = await temporaryRoot();
		const lockRoot = join(root, "locks");
		const identity = "workspace-stress-handoff";
		// 短租约强制 worker 之间频繁 stale 接管，容易踩到「目录已重建、owner 文件未写完」的交接窗口。
		const workers = Array.from({ length: 8 }, async () => {
			const lock = new WorkspaceLock({ lockRoot, retryMs: 1, leaseMs: 20, acquireTimeoutMs: 20_000 });
			for (let round = 0; round < 20; round += 1) {
				await lock.withLock(identity, async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
				});
			}
		});
		await expect(Promise.all(workers)).resolves.toHaveLength(8);
	});
});
