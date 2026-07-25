import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum } from "../src/encoding.ts";
import { GitRunner, type GitRunOptions, type GitRunResult } from "../src/git-runner.ts";
import { RootDiscovery, type RootTopology } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { WorkspaceLock } from "../src/workspace-lock.ts";
import {
	createGitRepo,
	createLocalSubmodule,
	createNestedRepo,
	readGitMetadata,
	runGit,
	writeFile as writeFixtureFile,
} from "./fixtures.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

class FailingGitRunner extends GitRunner {
	constructor(private readonly shouldFail: (args: readonly string[]) => boolean) {
		super();
	}

	override run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
		if (this.shouldFail(args)) {
			return Promise.reject(new Error(`注入 Git 失败：${args[0] ?? "unknown"}`));
		}
		return super.run(args, options);
	}
}

class ChangingDiscovery extends RootDiscovery {
	private calls = 0;

	override async discover(workspaceRoot: string): Promise<RootTopology> {
		const topology = await super.discover(workspaceRoot);
		this.calls += 1;
		return this.calls < 2 ? topology : { ...topology, fingerprint: "changed-topology" };
	}
}

class RecordingGitRunner extends GitRunner {
	readonly calls: Array<{ args: readonly string[]; options: GitRunOptions | undefined }> = [];

	override run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
		this.calls.push({ args, options });
		return super.run(args, options);
	}
}

class RecordingWorkspaceLock extends WorkspaceLock {
	readonly identities: string[] = [];

	override async withLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
		this.identities.push(identity);
		return fn();
	}
}

class BlockingGitRunner extends GitRunner {
	readonly started = deferred();
	readonly release = deferred();
	private blocked = false;

	override async run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
		if (!this.blocked && args[0] === "write-tree") {
			this.blocked = true;
			this.started.resolve();
			await this.release.promise;
		}
		return super.run(args, options);
	}
}

class InvalidUtf8TreeGitRunner extends GitRunner {
	override run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
		if (args[0] === "ls-tree") {
			const bytes = Buffer.concat([
				Buffer.from(`100644 blob ${"a".repeat(40)} 1\t`),
				Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74, 0]),
			]);
			return Promise.resolve(successfulGitResult(bytes));
		}
		if (args[0] === "cat-file" && args[1] === "-e") {
			return Promise.resolve(successfulGitResult(new Uint8Array()));
		}
		return super.run(args, options);
	}
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

function successfulGitResult(bytes: Uint8Array): GitRunResult {
	return {
		stdout: Buffer.from(bytes).toString("utf8"),
		stdoutBytes: new Uint8Array(bytes),
		stderr: "",
		code: 0,
		killed: false,
		timedOut: false,
		aborted: false,
	};
}

async function filesBelow(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				await visit(join(directory, entry.name), relativePath);
			} else {
				result.push(relativePath);
			}
		}
	}
	await visit(root, "");
	return result.sort();
}

async function expectNoPublishedManifest(storeRoot: string): Promise<void> {
	const files = await filesBelow(storeRoot);
	expect(files.filter((file) => file.includes("/manifests/") && file.endsWith(".json"))).toEqual([]);
}

describe("SnapshotStore", () => {
	it("storeRoot 位于 workspace 内时拒绝且不留下目录", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = join(workspace, ".pi-undo");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expect(access(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("storeRoot 经 workspace 外部 symlink 映射到 workspace 内时拒绝且不留下目录", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const aliasParent = await temporaryRoot("pi-undo-store-alias-");
		const alias = join(aliasParent, "workspace-alias");
		await symlink(workspace, alias, "dir");
		const storeRoot = join(alias, ".pi-undo");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expect(access(join(workspace, ".pi-undo"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("外部 storeRoot 的 stores symlink 指向 workspace 时拒绝且不写入", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await symlink(workspace, join(storeRoot, "stores"), "dir");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		expect((await readdir(workspace)).sort()).toEqual(["file.txt"]);
	});

	it("捕获 synthetic workspace 的文件、模式、二进制、大文件和 symlink，并排除 ignored", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await writeFixtureFile(workspace, ".gitignore", "ignored.txt\n");
		await writeFixtureFile(workspace, "tracked.txt", "tracked\n");
		await writeFixtureFile(workspace, "binary.bin", new Uint8Array([0, 1, 2, 255]));
		await writeFixtureFile(workspace, "large.bin", new Uint8Array(5 * 1024 * 1024).fill(7));
		await symlink("tracked.txt", join(workspace, "link.txt"));
		await writeFixtureFile(workspace, "ignored.txt", "ignored\n");

		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });
		const manifest = await store.capture(topology);
		const entries = await store.listTree(manifest.manifestId, ".");
		const paths = entries.map((entry) => entry.relativePath);

		expect(manifest.coverage).toBe("complete");
		expect(manifest.roots[0]).toEqual(expect.objectContaining({
			coverage: "complete",
			ignorePolicy: "git-check-ignore-v1",
			objectClosure: expect.stringMatching(/^[0-9a-f]{64}$/),
		}));
		expect(paths).toContain("tracked.txt");
		expect(paths).toContain("binary.bin");
		expect(paths).toContain("large.bin");
		expect(paths).toContain("link.txt");
		expect(paths).not.toContain("ignored.txt");
		expect(entries.find((entry) => entry.relativePath === "link.txt")).toEqual(
			expect.objectContaining({ kind: "symlink", linkText: "tracked.txt" }),
		);
		expect(entries.find((entry) => entry.relativePath === "large.bin")).toEqual(
			expect.objectContaining({ size: 5 * 1024 * 1024 }),
		);
		const binary = entries.find((entry) => entry.relativePath === "binary.bin");
		expect(binary?.blobId).not.toBeNull();
		expect(await store.readBlob(manifest.manifestId, ".", binary?.blobId as string))
			.toEqual(new Uint8Array([0, 1, 2, 255]));
		await store.assertComplete(manifest.manifestId);
	});

	it("多层 nested repository 各自捕获，并由每一层父 root 排除 descendant", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		const deeper = await createNestedRepo(child.root, "deeper");
		await writeFixtureFile(outer.root, "outer-only.txt", "outer\n");
		await writeFixtureFile(child.root, "child-only.txt", "child\n");
		await writeFixtureFile(deeper.root, "deeper-only.txt", "deeper\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(outer.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const outerPaths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);
		const childPaths = (await store.listTree(manifest.manifestId, "packages/child"))
			.map((entry) => entry.relativePath);
		const deeperPaths = (await store.listTree(manifest.manifestId, "packages/child/deeper"))
			.map((entry) => entry.relativePath);

		expect(outerPaths.some((path) => path.startsWith("packages/child"))).toBe(false);
		expect(childPaths).toContain("child-only.txt");
		expect(childPaths.some((path) => path.startsWith("deeper"))).toBe(false);
		expect(deeperPaths).toContain("deeper-only.txt");
	});

	it("partial scope 将特殊文件名作为 literal pathspec 处理", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const specialPath = ":magic[1]*.txt";
		await writeFixtureFile(workspace, specialPath, "literal\n");
		await writeFixtureFile(workspace, "other.txt", "other\n");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology, [specialPath]);

		expect((await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath))
			.toEqual([specialPath]);
	});

	it("忽略 .gitattributes 的 clean/eol 转换，保存工作区原始字节", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await writeFixtureFile(workspace, ".gitattributes", "*.txt text eol=lf\n");
		await writeFixtureFile(workspace, "line.txt", new Uint8Array([97, 13, 10]));
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const entry = (await store.listTree(manifest.manifestId, "."))
			.find((candidate) => candidate.relativePath === "line.txt");

		expect(await store.readBlob(manifest.manifestId, ".", entry?.blobId as string))
			.toEqual(new Uint8Array([97, 13, 10]));
	});

	it("隔离继承的 Git filter 配置，不执行 clean filter", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await writeFixtureFile(workspace, ".gitattributes", "*.txt filter=uppercase\n");
		await writeFixtureFile(workspace, "plain.txt", "lowercase\n");
		const topology = await new RootDiscovery().discover(workspace);
		const previous = new Map<string, string | undefined>();
		const injected = {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "filter.uppercase.clean",
			GIT_CONFIG_VALUE_0: "tr a-z A-Z",
			GIT_CONFIG_KEY_1: "filter.uppercase.required",
			GIT_CONFIG_VALUE_1: "true",
		};
		for (const [key, value] of Object.entries(injected)) {
			previous.set(key, process.env[key]);
			process.env[key] = value;
		}
		try {
			const store = new SnapshotStore({ storeRoot });
			const manifest = await store.capture(topology);
			const entry = (await store.listTree(manifest.manifestId, "."))
				.find((candidate) => candidate.relativePath === "plain.txt");
			expect(Buffer.from(await store.readBlob(manifest.manifestId, ".", entry?.blobId as string)).toString())
				.toBe("lowercase\n");
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("Git-backed root 的对象写入不执行 source clean filter 或 autocrlf", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await runGit(repository.root, ["config", "core.autocrlf", "true"]);
		await runGit(repository.root, ["config", "filter.uppercase.clean", "tr a-z A-Z"]);
		await runGit(repository.root, ["config", "filter.uppercase.required", "true"]);
		await writeFixtureFile(repository.root, ".gitattributes", "*.txt text eol=lf filter=uppercase\n");
		await writeFixtureFile(repository.root, "raw.txt", new Uint8Array([97, 13, 10]));
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const entry = (await store.listTree(manifest.manifestId, "."))
			.find((candidate) => candidate.relativePath === "raw.txt");

		expect(await store.readBlob(manifest.manifestId, ".", entry?.blobId as string))
			.toEqual(new Uint8Array([97, 13, 10]));
	});

	it("遇到无法无损表示的非 UTF-8 文件名时 fail-closed", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const topology = await new RootDiscovery().discover(workspace);
		const git = new InvalidUtf8TreeGitRunner();
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("遇到无法无损表示的非 UTF-8 symlink target 时 fail-closed", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		await symlink(Buffer.from([0xff]), join(workspace, "invalid-target-link"));
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("tracked path 的中间目录是 symlink 时拒绝越过 workspace 边界读取", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, "dir/file.txt", "inside\n");
		await runGit(repository.root, ["add", "dir/file.txt"]);
		await runGit(repository.root, ["commit", "-m", "add nested tracked fixture"]);
		await rm(join(repository.root, "dir"), { recursive: true });
		const outside = await temporaryRoot("pi-undo-outside-");
		await writeFixtureFile(outside, "file.txt", "outside\n");
		await symlink(outside, join(repository.root, "dir"), "dir");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology, ["dir/file.txt"])).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("父 root 排除 nested root，子 root 单独捕获且不修改真实 Git metadata", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		await writeFixtureFile(outer.root, "outer-dirty.txt", "outer\n");
		await writeFixtureFile(child.root, "child-dirty.txt", "child\n");
		const before = await readGitMetadata(outer.root);
		const beforeReflog = await runGit(outer.root, ["reflog", "show", "--format=%H%x00%gs"]);
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(outer.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const outerEntries = await store.listTree(manifest.manifestId, ".");
		const childEntries = await store.listTree(manifest.manifestId, "packages/child");

		expect(outerEntries.map((entry) => entry.relativePath)).not.toContain("packages/child/child-dirty.txt");
		expect(childEntries.map((entry) => entry.relativePath)).toContain("child-dirty.txt");
		expect(await readGitMetadata(outer.root)).toEqual(before);
		expect(await runGit(outer.root, ["reflog", "show", "--format=%H%x00%gs"])).toBe(beforeReflog);
	});

	it("capture 不修改 source config、stash、其他 refs 及其 reflog", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await runGit(repository.root, ["config", "pi-undo.fixture", "preserved"]);
		await writeFixtureFile(repository.root, "README.md", "stash fixture\n");
		await runGit(repository.root, ["stash", "push", "-m", "preserved stash"]);
		await runGit(repository.root, [
			"update-ref",
			"--create-reflog",
			"-m",
			"preserved ref",
			"refs/pi-undo/preserved",
			"HEAD",
		]);
		await writeFixtureFile(repository.root, "dirty.txt", "dirty\n");
		const before = await readGitMetadata(repository.root);
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		expect(Buffer.from(before.config ?? []).toString("utf8")).toContain("pi-undo");
		expect(before.stash).toMatch(/^[0-9a-f]{40,64}$/);
		expect(before.refs).toContain("refs/pi-undo/preserved");
		expect(before.reflogs).toContain("refs/pi-undo/preserved@{0}");
		expect(before.reflogs).toContain("refs/stash@{0}");

		await store.capture(topology);

		expect(await readGitMetadata(repository.root)).toEqual(before);
	});

	it("partial scope 不会把不相交的 child root 误捕获为全量", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		await writeFixtureFile(outer.root, "outer-only.txt", "outer\n");
		await writeFixtureFile(child.root, "child-only.txt", "child\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(outer.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology, ["outer-only.txt"]);

		expect(manifest.coverage).not.toBe("complete");
		expect((await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath)).toEqual([
			"outer-only.txt",
		]);
		expect(await store.listTree(manifest.manifestId, "packages/child")).toEqual([]);
		expect(manifest.roots.find((root) => root.relativeRoot === "packages/child")?.coverage).toBe("none");
	});

	it("workspace 内绝对 scope 被拒绝，不会产生虚假的 coverage", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology, [join(workspace, "file.txt")]))
			.rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("捕获 tracked、untracked 与 executable mode", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, "untracked.txt", "untracked\n");
		await writeFixtureFile(repository.root, "script.sh", "#!/bin/sh\nexit 0\n");
		await chmod(join(repository.root, "script.sh"), 0o755);
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const entries = await store.listTree(manifest.manifestId, ".");

		expect(entries.map((entry) => entry.relativePath)).toEqual(
			expect.arrayContaining(["README.md", "untracked.txt", "script.sh"]),
		);
		expect(entries.find((entry) => entry.relativePath === "script.sh")?.mode).toBe(0o100755);
	});

	it("Git-backed root 捕获命中 ignore pattern 的现存 tracked 文件", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, ".gitignore", "tracked-ignored.txt\nuntracked-ignored.txt\n");
		await writeFixtureFile(repository.root, "tracked-ignored.txt", "tracked\n");
		await runGit(repository.root, ["add", ".gitignore"]);
		await runGit(repository.root, ["add", "-f", "tracked-ignored.txt"]);
		await runGit(repository.root, ["commit", "-m", "add ignored tracked fixture"]);
		await writeFixtureFile(repository.root, "untracked-visible.txt", "visible\n");
		await writeFixtureFile(repository.root, "untracked-ignored.txt", "ignored\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const paths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);

		expect(paths).toContain("tracked-ignored.txt");
		expect(paths).toContain("untracked-visible.txt");
		expect(paths).not.toContain("untracked-ignored.txt");
	});

	it("Git-backed root 不把已从 worktree 删除的 tracked 文件写入快照", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await rm(join(repository.root, "README.md"));
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const paths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);

		expect(paths).not.toContain("README.md");
	});

	it("Git-backed root 使用真实仓库 info/exclude 过滤 untracked 文件", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, ".git/info/exclude", "info-ignored.txt\n");
		await writeFixtureFile(repository.root, "info-ignored.txt", "ignored\n");
		await writeFixtureFile(repository.root, "info-visible.txt", "visible\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		const paths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);

		expect(paths).toContain("info-visible.txt");
		expect(paths).not.toContain("info-ignored.txt");
	});

	it("Git-backed source 查询清除继承 repository/index/config 环境并禁用 fsmonitor", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, "untracked.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const hook = join(repository.root, ".git", "hooks", "pi-undo-fsmonitor");
		const marker = `${hook}.called`;
		await writeFixtureFile(repository.root, ".git/hooks/pi-undo-fsmonitor", [
			"#!/bin/sh",
			`touch ${JSON.stringify(marker)}`,
			"exit 1",
			"",
		].join("\n"));
		await chmod(hook, 0o755);
		await runGit(repository.root, ["config", "core.fsmonitor", hook]);
		const git = new RecordingGitRunner();
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		await store.capture(topology);

		const sourceCall = git.calls.find((call) => call.args.includes("--cached"));
		expect(sourceCall?.args).toEqual(expect.arrayContaining(["-c", "core.fsmonitor=false", "ls-files"]));
		expect(sourceCall?.options?.env).toEqual(expect.objectContaining({
			GIT_DIR: undefined,
			GIT_WORK_TREE: undefined,
			GIT_INDEX_FILE: undefined,
			GIT_COMMON_DIR: undefined,
			GIT_CONFIG_COUNT: undefined,
			GIT_CONFIG_PARAMETERS: undefined,
			GIT_OPTIONAL_LOCKS: "0",
		}));
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("initialized submodule 独立捕获，父 root 排除整个 child，child 使用自己的 ignore", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/child");
		temporaryRoots.push(child.sourceRoot);
		await writeFixtureFile(child.root, ".gitignore", "child-ignored.txt\n");
		await writeFixtureFile(child.root, "child-untracked.txt", "child\n");
		await writeFixtureFile(child.root, "child-ignored.txt", "ignored\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(outer.root);
		const store = new SnapshotStore({ storeRoot });
		const outerBefore = await readGitMetadata(outer.root);
		const childBefore = await readGitMetadata(child.root);
		const outerReflog = await runGit(outer.root, ["reflog", "show", "--format=%H%x00%gs"]);
		const childReflog = await runGit(child.root, ["reflog", "show", "--format=%H%x00%gs"]);

		const manifest = await store.capture(topology);
		const outerPaths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);
		const childPaths = (await store.listTree(manifest.manifestId, "modules/child"))
			.map((entry) => entry.relativePath);

		expect(outerPaths.some((path) => path === "modules/child" || path.startsWith("modules/child/"))).toBe(false);
		expect(childPaths).toContain("child-untracked.txt");
		expect(childPaths).not.toContain("child-ignored.txt");
		expect(await readGitMetadata(outer.root)).toEqual(outerBefore);
		expect(await readGitMetadata(child.root)).toEqual(childBefore);
		expect(await runGit(outer.root, ["reflog", "show", "--format=%H%x00%gs"])).toBe(outerReflog);
		expect(await runGit(child.root, ["reflog", "show", "--format=%H%x00%gs"])).toBe(childReflog);
	});

	it("broken root 不发布 manifest", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "packages/child");
		temporaryRoots.push(child.sourceRoot);
		await rm(join(child.root, ".git"), { recursive: true, force: true });
		const topology = await new RootDiscovery().discover(outer.root);
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("manifest 可重新加载，pin 和 unpin 具有持久化幂等性", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		const manifest = await store.capture(topology);
		await store.pin(manifest.manifestId, "session");
		await store.pin(manifest.manifestId, "session");
		const pinPath = (await filesBelow(storeRoot)).find((file) => file.includes("/pins/"));
		expect(pinPath).toBeDefined();
		expect(JSON.parse(await readFile(join(storeRoot, pinPath as string), "utf8"))).toEqual(
			expect.objectContaining({ manifestId: manifest.manifestId, reasons: ["session"] }),
		);
		await store.unpin(manifest.manifestId, "session");
		await store.unpin(manifest.manifestId, "session");
		expect(await store.loadManifest(manifest.manifestId)).toEqual(manifest);
		expect((await filesBelow(storeRoot)).filter((file) => file.includes("/pins/"))).toEqual([]);
	});

	it("最后一个 reason 的 unpin 刷新 GC 元数据失败时保留 pin", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });
		const manifest = await store.capture(topology);
		await store.pin(manifest.manifestId, "session");
		const files = await filesBelow(storeRoot);
		const pinPath = files.find((file) => file.includes("/pins/"));
		const gcPath = files.find((file) => file.endsWith("/gc.json"));
		expect(pinPath).toBeDefined();
		expect(gcPath).toBeDefined();
		const absolutePinPath = join(storeRoot, pinPath as string);
		const absoluteGcPath = join(storeRoot, gcPath as string);
		await rm(absoluteGcPath);
		await mkdir(absoluteGcPath);

		await expect(store.unpin(manifest.manifestId, "session")).rejects.toThrow();
		await expect(access(absolutePinPath)).resolves.toBeUndefined();
		expect(JSON.parse(await readFile(absolutePinPath, "utf8"))).toEqual(
			expect.objectContaining({ reasons: ["session"] }),
		);
	});

	it("隔离真实 object database 后私有 tree 仍完整且没有 alternates", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, "dirty.txt", "dirty\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const store = new SnapshotStore({ storeRoot });
		const manifest = await store.capture(topology);
		const isolatedObjects = await temporaryRoot("pi-undo-real-objects-");
		await rm(isolatedObjects, { recursive: true, force: true });
		await rename(join(repository.root, ".git", "objects"), isolatedObjects);

		await expect(store.assertComplete(manifest.manifestId)).resolves.toBeUndefined();
		expect((await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath)).toContain("dirty.txt");
		expect((await filesBelow(storeRoot)).some((file) => file.endsWith("objects/info/alternates"))).toBe(false);
	});

	it("私有 Git 命令显式清除继承的 repository、index 与 worktree 环境", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const git = new RecordingGitRunner();
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		await store.capture(topology);

		const privateCall = git.calls.find((call) => call.args[0] === "ls-tree");
		expect(privateCall?.options?.env).toHaveProperty("GIT_INDEX_FILE", undefined);
		expect(privateCall?.options?.env).toHaveProperty("GIT_WORK_TREE", undefined);
		expect(privateCall?.options?.env).toHaveProperty("GIT_COMMON_DIR", undefined);
		const initCall = git.calls.find((call) => call.args[0] === "init");
		expect(initCall?.options?.env).toHaveProperty("GIT_DIR", undefined);
		expect(initCall?.options?.env).toHaveProperty("GIT_INDEX_FILE", undefined);
		const hashCall = git.calls.find((call) => call.args[0] === "hash-object");
		expect(hashCall?.options?.env).toHaveProperty("GIT_CONFIG_COUNT", undefined);
		expect(hashCall?.options?.env).toHaveProperty("GIT_CONFIG_GLOBAL", process.platform === "win32" ? "NUL" : "/dev/null");
		expect(hashCall?.options?.env).toHaveProperty("GIT_CONFIG_NOSYSTEM", "1");
	});

	it("capture 前后 topology 不一致时不发布 manifest", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot, discovery: new ChangingDiscovery() });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("拒绝 roots 与 fingerprint 不一致的伪造 topology，且不执行 Git 捕获", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const forgedSourceIdentity = "forged-source";
		const forged: RootTopology = {
			...topology,
			roots: topology.roots.map((root, index) => index === 0 ? {
				...root,
				sourceIdentity: forgedSourceIdentity,
				privateRepositoryId: checksum(forgedSourceIdentity),
			} : root),
		};
		const git = new RecordingGitRunner();
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		await expect(store.capture(forged)).rejects.toMatchObject({ code: "capture_failed" });
		expect(git.calls).toEqual([]);
		await expectNoPublishedManifest(storeRoot);
	});

	it("拒绝伪造 gitBacked=false 并导致 tracked-ignore 漏拍的 topology", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFixtureFile(repository.root, ".gitignore", "tracked-ignored.txt\n");
		await writeFixtureFile(repository.root, "tracked-ignored.txt", "tracked\n");
		await runGit(repository.root, ["add", ".gitignore"]);
		await runGit(repository.root, ["add", "-f", "tracked-ignored.txt"]);
		await runGit(repository.root, ["commit", "-m", "add tracked ignored fixture"]);
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(repository.root);
		const forged: RootTopology = {
			...topology,
			roots: topology.roots.map((root) => ({ ...root, gitBacked: false })),
		};
		const git = new RecordingGitRunner();
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		const outcome = await store.capture(forged).then(
			async (manifest) => ({
				status: "published" as const,
				paths: (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath),
			}),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);

		expect(outcome).toEqual({
			status: "rejected",
			error: expect.objectContaining({ code: "capture_failed" }),
		});
		expect(git.calls.some((call) => ["init", "read-tree", "hash-object", "update-index", "write-tree"]
			.includes(call.args[0] ?? ""))).toBe(false);
		await expectNoPublishedManifest(storeRoot);
	});

	it("发布辅助元数据失败时不会留下可见 manifest", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const outer = topology.roots.find((root) => root.relativeRoot === ".");
		const storeId = checksum(canonicalJson({
			schemaVersion: 1,
			workspaceIdentity: topology.workspaceIdentity,
			sourceIdentity: outer?.sourceIdentity,
		}));
		await mkdir(join(storeRoot, "stores", storeId, "gc.json"), { recursive: true });
		const store = new SnapshotStore({ storeRoot });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it.each([
		["write-tree", (args: readonly string[]) => args[0] === "write-tree"],
		["ignore 查询", (args: readonly string[]) => args[0] === "check-ignore"],
		["hash-object", (args: readonly string[]) => args[0] === "hash-object"],
		["update-index", (args: readonly string[]) => args[0] === "update-index"],
		["对象完整性", (args: readonly string[]) => args[0] === "cat-file"],
	] as const)("%s 失败时不发布 manifest", async (_name, shouldFail) => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const git = new FailingGitRunner(shouldFail);
		const store = new SnapshotStore({ storeRoot, git, discovery: new RootDiscovery(git) });

		await expect(store.capture(topology)).rejects.toMatchObject({ code: "capture_failed" });
		await expectNoPublishedManifest(storeRoot);
	});

	it("合法空工作区与未命中的 scope 都产生可验证空 tree", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });

		const emptyManifest = await store.capture(topology);
		expect(await store.listTree(emptyManifest.manifestId, ".")).toEqual([]);
		await expect(store.assertComplete(emptyManifest.manifestId)).resolves.toBeUndefined();

		const populatedWorkspace = await temporaryRoot("pi-undo-snapshot-");
		const scopedStoreRoot = await temporaryRoot("pi-undo-store-");
		await writeFixtureFile(populatedWorkspace, "file.txt", "content\n");
		const updated = await new RootDiscovery().discover(populatedWorkspace);
		const scopedStore = new SnapshotStore({ storeRoot: scopedStoreRoot });
		const scopedManifest = await scopedStore.capture(updated, ["missing.txt"]);
		expect(await scopedStore.listTree(scopedManifest.manifestId, ".")).toEqual([]);
		await expect(scopedStore.assertComplete(scopedManifest.manifestId)).resolves.toBeUndefined();
	});

	it("GC 仅清理取消全部 pin 且超过七天的 store", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		let now = Date.UTC(2026, 6, 24);
		const store = new SnapshotStore({ storeRoot, clock: () => now });
		const manifest = await store.capture(topology);
		await store.pin(manifest.manifestId, "session");
		now += 8 * 24 * 60 * 60 * 1_000;

		expect(await store.collectGarbage()).toBe(0);
		await store.unpin(manifest.manifestId, "session");
		now += 6 * 24 * 60 * 60 * 1_000;
		expect(await store.collectGarbage()).toBe(0);
		now += 2 * 24 * 60 * 60 * 1_000;
		expect(await store.collectGarbage()).toBe(1);
		await expect(store.loadManifest(manifest.manifestId)).rejects.toMatchObject({ code: "manifest_not_found" });
	});

	it("任一 session、cursor 或 journal pin 仍存在时 GC 都不会删除 store", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		let now = Date.UTC(2026, 6, 24);
		const store = new SnapshotStore({ storeRoot, clock: () => now });
		const manifest = await store.capture(topology);
		await store.pin(manifest.manifestId, "session:one");
		await store.pin(manifest.manifestId, "cursor:one");
		await store.pin(manifest.manifestId, "journal:one");
		now += 8 * 24 * 60 * 60 * 1_000;

		await store.unpin(manifest.manifestId, "session:one");
		await store.unpin(manifest.manifestId, "cursor:one");
		expect(await store.collectGarbage()).toBe(0);
		expect(await store.loadManifest(manifest.manifestId)).toEqual(manifest);
	});

	it("storeRoot alias 的所有 mutation 使用同一 canonical lock identity", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const aliasParent = await temporaryRoot("pi-undo-store-alias-");
		const aliasRoot = join(aliasParent, "store-alias");
		await symlink(storeRoot, aliasRoot, "dir");
		const topology = await new RootDiscovery().discover(workspace);
		const lock = new RecordingWorkspaceLock();
		const aliasStore = new SnapshotStore({ storeRoot: aliasRoot, lock });
		const physicalStore = new SnapshotStore({ storeRoot, lock });

		const manifest = await aliasStore.capture(topology);
		await physicalStore.pin(manifest.manifestId, "session");
		await aliasStore.unpin(manifest.manifestId, "session");
		expect(await physicalStore.collectGarbage()).toBe(0);

		const identity = `snapshot-store:${await realpath(join(storeRoot, "stores"))}`;
		expect(lock.identities).toEqual([identity, identity, identity, identity]);
	});

	it("并发 pin 不会丢失任一引用 reason", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		const store = new SnapshotStore({ storeRoot });
		const manifest = await store.capture(topology);
		const reasons = Array.from({ length: 16 }, (_, index) => `session:${index}`);

		await Promise.all(reasons.map((reason) => new SnapshotStore({ storeRoot }).pin(manifest.manifestId, reason)));

		const pinPath = (await filesBelow(storeRoot)).find((file) => file.includes("/pins/"));
		const pin = JSON.parse(await readFile(join(storeRoot, pinPath as string), "utf8")) as { reasons: string[] };
		expect(pin.reasons).toEqual([...reasons].sort());
	});

	it("物理 storeRoot 与 symlink alias 并发 pin 不会丢失任一引用 reason", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "content\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const aliasParent = await temporaryRoot("pi-undo-store-alias-");
		const aliasRoot = join(aliasParent, "store-alias");
		await symlink(storeRoot, aliasRoot, "dir");
		const topology = await new RootDiscovery().discover(workspace);
		const manifest = await new SnapshotStore({ storeRoot }).capture(topology);
		const reasons = Array.from({ length: 32 }, (_, index) => `session:${index}`);

		await Promise.all(reasons.map((reason, index) => new SnapshotStore({
			storeRoot: index % 2 === 0 ? storeRoot : aliasRoot,
		}).pin(manifest.manifestId, reason)));

		const pinPath = (await filesBelow(storeRoot)).find((file) => file.includes("/pins/"));
		const pin = JSON.parse(await readFile(join(storeRoot, pinPath as string), "utf8")) as { reasons: string[] };
		expect(pin.reasons).toEqual([...reasons].sort());
	});

	it("GC 不会删除正在 capture 使用的旧 store", async () => {
		const workspace = await temporaryRoot("pi-undo-snapshot-");
		await writeFixtureFile(workspace, "file.txt", "before\n");
		const storeRoot = await temporaryRoot("pi-undo-store-");
		const topology = await new RootDiscovery().discover(workspace);
		let now = Date.UTC(2026, 6, 24);
		await new SnapshotStore({ storeRoot, clock: () => now }).capture(topology);
		now += 8 * 24 * 60 * 60 * 1_000;
		await writeFixtureFile(workspace, "file.txt", "after\n");
		const blockingGit = new BlockingGitRunner();
		const capturingStore = new SnapshotStore({
			storeRoot,
			clock: () => now,
			git: blockingGit,
			discovery: new RootDiscovery(blockingGit),
		});
		const capture = capturingStore.capture(topology);
		await blockingGit.started.promise;
		const garbageCollection = new SnapshotStore({ storeRoot, clock: () => now }).collectGarbage();
		await new Promise((resolve) => setTimeout(resolve, 30));
		blockingGit.release.resolve();

		const [captureResult, gcResult] = await Promise.allSettled([capture, garbageCollection]);

		expect(captureResult.status).toBe("fulfilled");
		expect(gcResult).toEqual({ status: "fulfilled", value: 0 });
	});
});
