import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
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
});
