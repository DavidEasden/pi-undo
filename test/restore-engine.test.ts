import { access, chmod, lstat, mkdtemp, readFile, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, checksum, topologyFingerprint } from "../src/encoding.ts";
import { RestoreEngine, type RestoreMutation } from "../src/restore-engine.ts";
import type { ManifestId, RestorePath, SnapshotManifest } from "../src/model.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore, SnapshotStoreError } from "../src/snapshot-store.ts";
import {
	createGitRepo,
	createLocalSubmodule,
	createNestedRepo,
	readGitMetadata,
	writeFile,
} from "./fixtures.ts";

const temporaryRoots: string[] = [];

class FailingUnpinSnapshotStore extends SnapshotStore {
	override unpin(_id: ManifestId, _reason: string): Promise<void> {
		return Promise.reject(new Error("注入 unpin 失败"));
	}
}

class ToggleIncompleteSnapshotStore extends SnapshotStore {
	failCompleteness = false;

	override assertComplete(id: ManifestId): Promise<void> {
		if (this.failCompleteness) {
			return Promise.reject(new SnapshotStoreError("object_missing", `注入对象闭包损坏：${id}`));
		}
		return super.assertComplete(id);
	}
}

class ToggleListTreeFailureSnapshotStore extends SnapshotStore {
	failListTree = false;

	override listTree(id: ManifestId, root: string): Promise<readonly RestorePath[]> {
		if (this.failListTree) {
			return Promise.reject(new Error(`注入 listTree 契约错误：${id}:${root}`));
		}
		return super.listTree(id, root);
	}
}

class GitMetadataTreeSnapshotStore extends SnapshotStore {
	injectGitMetadata = false;
	gitMetadataPath = ".git";

	override async listTree(id: ManifestId, root: string): Promise<readonly RestorePath[]> {
		const entries = await super.listTree(id, root);
		if (!this.injectGitMetadata || root !== ".") {
			return entries;
		}
		return [...entries, {
			relativePath: this.gitMetadataPath,
			kind: "directory",
			mode: 0o755,
			blobId: null,
			size: 0,
			rootHash: "0".repeat(64),
		}];
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
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

function withBrokenRoot(manifest: SnapshotManifest): SnapshotManifest {
	const { manifestId: _manifestId, ...manifestFields } = manifest;
	const roots: SnapshotManifest["roots"] = manifest.roots.map((root, index) =>
		index === 0 ? { ...root, state: "broken", treeId: null } : root
	);
	const semantic: Omit<SnapshotManifest, "manifestId"> = {
		...manifestFields,
		roots,
		topologyFingerprint: topologyFingerprint(manifest.workspaceIdentity, roots),
	};
	return {
		...semantic,
		manifestId: checksum(canonicalJson(semantic)) as ManifestId,
	};
}

function withActiveNullTree(manifest: SnapshotManifest): SnapshotManifest {
	const { manifestId: _manifestId, ...manifestFields } = manifest;
	const roots: SnapshotManifest["roots"] = manifest.roots.map((root, index) =>
		index === 0 ? { ...root, state: "active", treeId: null } : root
	);
	const semantic: Omit<SnapshotManifest, "manifestId"> = {
		...manifestFields,
		roots,
		topologyFingerprint: topologyFingerprint(manifest.workspaceIdentity, roots),
	};
	return {
		...semantic,
		manifestId: checksum(canonicalJson(semantic)) as ManifestId,
	};
}

describe("RestoreEngine", () => {
	it("计划使用 root 并集并生成确定的深浅顺序与 digest", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		await writeFile(outer.root, "old/deep/outer.txt", "outer-old\n");
		await writeFile(child.root, "old/deep/child.txt", "child-old\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const current = await store.capture(await discovery.discover(outer.root));

		await rm(join(outer.root, "old"), { recursive: true });
		await rm(join(child.root, "old"), { recursive: true });
		await writeFile(outer.root, "new/deep/outer.txt", "outer-new\n");
		await writeFile(child.root, "new/deep/child.txt", "child-new\n");
		const target = await store.capture(await discovery.discover(outer.root));
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });

		const first = await engine.plan(current, target);
		const second = await engine.plan(current, target);

		expect(first.boundaryRoots).toEqual([".", "packages/child"]);
		expect(first.deletePaths).toEqual([
			"packages/child/old/deep/child.txt",
			"packages/child/old/deep",
			"old/deep/outer.txt",
			"packages/child/old",
			"old/deep",
			"old",
		]);
		expect(first.writePaths).toEqual([
			"new",
			"new/deep",
			"packages/child/new",
			"packages/child/new/deep",
			"new/deep/outer.txt",
			"packages/child/new/deep/child.txt",
		]);
		expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toEqual(first);
	});

	it("apply 与 rollback 均按 delete、mkdir、叶子写入三阶段执行", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		await writeFile(outer.root, "target/deep/outer.txt", "target-outer\n");
		await writeFile(child.root, "target/deep/child.txt", "target-child\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		await rm(join(outer.root, "target"), { recursive: true });
		await rm(join(child.root, "target"), { recursive: true });
		await writeFile(outer.root, "current/deep/outer.txt", "current-outer\n");
		await writeFile(child.root, "current/deep/child.txt", "current-child\n");
		const current = await store.capture(await discovery.discover(outer.root));
		const mutations: RestoreMutation[] = [];
		const engine = new RestoreEngine({
			workspaceRoot: outer.root,
			store,
			discovery,
			beforeMutation: (mutation) => {
				mutations.push(mutation);
				if (mutation.phase === "apply" && mutation.path === "packages/child/target/deep/child.txt") {
					throw new Error("注入 apply 叶子写入失败");
			}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		for (const phase of ["apply", "rollback"] as const) {
			const phaseMutations = mutations.filter((mutation) => mutation.phase === phase);
			const firstNonDelete = phaseMutations.findIndex((mutation) => mutation.kind !== "delete");
			const firstLeaf = phaseMutations.findIndex(
				(mutation) => mutation.kind === "write" || mutation.kind === "symlink",
			);
			expect(firstNonDelete).toBeGreaterThan(0);
			expect(phaseMutations.slice(0, firstNonDelete).every((mutation) => mutation.kind === "delete")).toBe(true);
			expect(firstLeaf).toBeGreaterThan(firstNonDelete);
			expect(phaseMutations.slice(firstNonDelete, firstLeaf).every((mutation) => mutation.kind === "mkdir")).toBe(true);
			expect(phaseMutations.slice(firstLeaf).every((mutation) => mutation.kind !== "mkdir")).toBe(true);
			const leafPaths = phaseMutations
				.filter((mutation) => mutation.kind === "write" || mutation.kind === "symlink")
				.map((mutation) => mutation.path);
			expect(leafPaths.findIndex((path) => !path.startsWith("packages/child/"))).toBeLessThan(
				leafPaths.findIndex((path) => path.startsWith("packages/child/")),
			);
		}
	});

	it("set-state 恢复普通内容并保留 ignored 与真实 Git metadata", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		const largeTarget = new Uint8Array(5 * 1024 * 1024 + 17).fill(7);
		await writeFile(repository.root, ".gitignore", "ignored.txt\n");
		await writeFile(repository.root, "text.txt", "target\n");
		await writeFile(repository.root, "binary.bin", new Uint8Array([0, 1, 2, 255]));
		await writeFile(repository.root, "large.bin", largeTarget);
		await writeFile(repository.root, "script.sh", "#!/bin/sh\nexit 0\n");
		await chmod(join(repository.root, "script.sh"), 0o755);
		await symlink("text.txt", join(repository.root, "link.txt"));
		await writeFile(repository.root, "kind/file-node", "target-file\n");
		await writeFile(repository.root, "kind/dir-node/child.txt", "target-child\n");
		await writeFile(repository.root, "ignored.txt", "target-ignored\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(repository.root));

		await writeFile(repository.root, "text.txt", "current\n");
		await writeFile(repository.root, "binary.bin", new Uint8Array([9, 8, 7]));
		await writeFile(repository.root, "large.bin", new Uint8Array(5 * 1024 * 1024 + 17).fill(9));
		await chmod(join(repository.root, "script.sh"), 0o644);
		await rm(join(repository.root, "link.txt"));
		await symlink("README.md", join(repository.root, "link.txt"));
		await rm(join(repository.root, "kind/file-node"));
		await writeFile(repository.root, "kind/file-node/child.txt", "current-child\n");
		await rm(join(repository.root, "kind/dir-node"), { recursive: true });
		await writeFile(repository.root, "kind/dir-node", "current-file\n");
		await writeFile(repository.root, "ignored.txt", "preserve-ignored\n");
		const current = await store.capture(await discovery.discover(repository.root));
		const metadataBefore = await readGitMetadata(repository.root);
		const engine = new RestoreEngine({ workspaceRoot: repository.root, store, discovery });

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result).toEqual(expect.objectContaining({
			code: "ok",
			verifiedPaths: expect.any(Number),
			totalPaths: expect.any(Number),
			postFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		}));
		expect(await readFile(join(repository.root, "text.txt"), "utf8")).toBe("target\n");
		expect(await readFile(join(repository.root, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(await readFile(join(repository.root, "large.bin"))).toEqual(Buffer.from(largeTarget));
		expect((await lstat(join(repository.root, "script.sh"))).mode & 0o777).toBe(0o755);
		expect(await readlink(join(repository.root, "link.txt"))).toBe("text.txt");
		expect(await readFile(join(repository.root, "kind/file-node"), "utf8")).toBe("target-file\n");
		expect(await readFile(join(repository.root, "kind/dir-node/child.txt"), "utf8")).toBe("target-child\n");
		expect(await readFile(join(repository.root, "ignored.txt"), "utf8")).toBe("preserve-ignored\n");
		expect((await lstat(join(repository.root, ".git"))).isDirectory()).toBe(true);
		expect(await readGitMetadata(repository.root)).toEqual(metadataBefore);
	});

	it("scoped restore 只修改 checkpoint changedPaths，保留 scope 外手动修改", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "agent.txt", "before\n");
		await writeFile(workspace, "manual.txt", "original\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));

		await writeFile(workspace, "agent.txt", "after\n");
		await writeFile(workspace, "manual.txt", "user-edit\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });

		const plan = await engine.plan(current, target, ["agent.txt"]);
		expect(plan.deletePaths).toEqual([]);
		expect(plan.writePaths).toEqual(["agent.txt"]);
		expect((await engine.apply(plan, target)).code).toBe("ok");
		expect(await readFile(join(workspace, "agent.txt"), "utf8")).toBe("before\n");
		expect(await readFile(join(workspace, "manual.txt"), "utf8")).toBe("user-edit\n");
	});

	it("删除受控叶子时保留含 ignored 文件的目录", async () => {
		const repository = await createGitRepo();
		temporaryRoots.push(repository.root);
		await writeFile(repository.root, ".gitignore", "managed-dir/ignored.txt\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(repository.root));

		await writeFile(repository.root, "managed-dir/tracked.txt", "remove-me\n");
		await writeFile(repository.root, "managed-dir/ignored.txt", "preserve-me\n");
		const current = await store.capture(await discovery.discover(repository.root));
		const engine = new RestoreEngine({ workspaceRoot: repository.root, store, discovery });

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("ok");
		await expect(access(join(repository.root, "managed-dir/tracked.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await readFile(join(repository.root, "managed-dir/ignored.txt"), "utf8")).toBe("preserve-me\n");
	});

	it("target ignored-present proof 保留 current-only 叶子但不豁免真实删除", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, ".gitignore", "cache/volatile.txt\n");
		await writeFile(workspace, "cache/volatile.txt", "target-ignored\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, ".gitignore", "");
		await writeFile(workspace, "cache/volatile.txt", "preserve-current\n");
		await writeFile(workspace, "removed.txt", "remove-current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });

		const plan = await engine.plan(current, target);

		expect(plan.deletePaths).not.toContain("cache/volatile.txt");
		expect(plan.deletePaths).not.toContain("cache");
		expect(plan.deletePaths).toContain("removed.txt");
		expect((await engine.apply(plan, target)).code).toBe("ok");
		expect(await readFile(join(workspace, "cache/volatile.txt"), "utf8")).toBe("preserve-current\n");
		await expect(access(join(workspace, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("相同 partial coverage 下 ownership 迁移仍以全局缺失为准", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const scopedPath = "packages/child/managed.txt";
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root), [scopedPath]);

		const child = await createNestedRepo(outer.root, "packages/child");
		await writeFile(child.root, "managed.txt", "remove-me\n");
		const current = await store.capture(await discovery.discover(outer.root), [scopedPath]);
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });

		const plan = await engine.plan(current, target);

		expect(current.coverage).toBe(target.coverage);
		expect(plan.boundaryRoots).toEqual([".", "packages/child"]);
		expect(plan.deletePaths).toContain(scopedPath);
		const result = await engine.apply(plan, target);
		expect(result.code).toBe("ok");
		expect(result.totalPaths).toBeGreaterThan(0);
		expect(result.verifiedPaths).toBe(result.totalPaths);
		await expect(access(join(outer.root, scopedPath))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(join(child.root, ".git"))).isDirectory()).toBe(true);
		expect(await readFile(join(child.root, "README.md"), "utf8")).toBe("fixture\n");
	});

	it("plan 后 unchanged managed path 漂移时不执行任何 mutation", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "changed.txt", "target\n");
		await writeFile(workspace, "unchanged.txt", "stable\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "changed.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);
		await writeFile(workspace, "unchanged.txt", "external-drift\n");

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(workspace, "changed.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(workspace, "unchanged.txt"), "utf8")).toBe("external-drift\n");
	});

	it("complete coverage 在 mutation 前拒绝 manifest 并集外新增可见路径", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "changed.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "changed.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		let mutations = 0;
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: () => {
				mutations += 1;
			},
		});
		const plan = await engine.plan(current, target);
		await writeFile(workspace, "intruder.txt", "outside-union\n");

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("restore_failed_safe");
		expect(mutations).toBe(0);
		expect(await readFile(join(workspace, "changed.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(workspace, "intruder.txt"), "utf8")).toBe("outside-union\n");
	});

	it("complete coverage 在 apply 后发现并集外新增路径并 rollback", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "changed.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "changed.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		let rollbackObserved = false;
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await writeFile(workspace, "intruder.txt", "outside-union\n");
				}
				if (mutation.phase === "rollback" && mutation.ordinal === 1) {
					rollbackObserved = true;
					await rm(join(workspace, "intruder.txt"));
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(rollbackObserved).toBe(true);
		expect(await readFile(join(workspace, "changed.txt"), "utf8")).toBe("current\n");
		await expect(access(join(workspace, "intruder.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("complete rollback 无法证明 current 集合时不返回 safe", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "changed.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "changed.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await writeFile(workspace, "intruder.txt", "outside-union\n");
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(["partial_restore", "recovery_required"]).toContain(result.code);
		expect(result.code).not.toBe("restore_failed_safe");
		expect(await readFile(join(workspace, "changed.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(workspace, "intruder.txt"), "utf8")).toBe("outside-union\n");
	});

	it("target-only nested root 显式创建 boundary 骨架但不重建 Git metadata", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createNestedRepo(outer.root, "packages/child");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		await rm(child.root, { recursive: true });
		const current = await store.capture(await discovery.discover(outer.root));
		const metadataBefore = await readGitMetadata(outer.root);
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });

		const plan = await engine.plan(current, target);

		expect(plan.writePaths).toEqual(expect.arrayContaining([
			"packages",
			"packages/child",
			"packages/child/README.md",
		]));
		expect(plan.writePaths.indexOf("packages")).toBeLessThan(plan.writePaths.indexOf("packages/child"));
		expect(plan.writePaths.indexOf("packages/child")).toBeLessThan(
			plan.writePaths.indexOf("packages/child/README.md"),
		);
		expect((await engine.apply(plan, target)).code).toBe("ok");
		expect(await readFile(join(child.root, "README.md"), "utf8")).toBe("fixture\n");
		await expect(access(join(child.root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await discovery.discover(outer.root)).roots.map((root) => root.relativeRoot)).toEqual(["."]);
		expect(await readGitMetadata(outer.root)).toEqual(metadataBefore);
	});

	it("第 k 个 apply mutation 失败时自动 rollback 到 current manifest", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "a.txt", "target-a\n");
		await writeFile(workspace, "b.txt", "target-b\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "a.txt", "current-a\n");
		await writeFile(workspace, "b.txt", "current-b\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 2) {
					throw new Error("注入 apply mutation 失败");
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current-a\n");
		expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("current-b\n");
	});

	it("rollback 再失败时返回 partial/recovery 并保留 recovery pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "a.txt", "target-a\n");
		await writeFile(workspace, "b.txt", "target-b\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "a.txt", "current-a\n");
		await writeFile(workspace, "b.txt", "current-b\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: (mutation) => {
				if (
					(mutation.phase === "apply" && mutation.ordinal === 2) ||
					(mutation.phase === "rollback" && mutation.ordinal === 1)
				) {
					throw new Error("注入双重 mutation 失败");
				}
			},
		});
		const plan = await engine.plan(current, target);

		const result = await engine.apply(plan, target);

		expect(["partial_restore", "recovery_required"]).toContain(result.code);
		expect(result.code).not.toBe("restore_failed_safe");
		const pinFiles = (await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"));
		expect(pinFiles).toHaveLength(2);
		for (const pinFile of pinFiles) {
			expect(JSON.parse(await readFile(join(storeRoot, pinFile), "utf8"))).toEqual(
				expect.objectContaining({ reasons: [`restore:${plan.planDigest}`] }),
			);
		}

		await writeFile(workspace, "b.txt", "external-drift\n");
		const retry = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		expect((await retry.apply(plan, target)).code).toBe("restore_failed_safe");
		const pinsAfterRetry = (await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"));
		expect(pinsAfterRetry).toHaveLength(2);
		for (const pinFile of pinsAfterRetry) {
			expect(JSON.parse(await readFile(join(storeRoot, pinFile), "utf8"))).toEqual(
				expect.objectContaining({ reasons: [`restore:${plan.planDigest}`] }),
			);
		}

		await writeFile(workspace, "b.txt", "current-b\n");
		expect((await retry.apply(plan, target)).code).toBe("ok");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("已验证 ok 后 unpin 失败只泄漏 pin 而不改写结果", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new FailingUnpinSnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("ok");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("target\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toHaveLength(2);
	});

	it("plan 后出现 union 外 topology drift 时在 mutation 前 fail-safe", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await writeFile(outer.root, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		await writeFile(outer.root, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(outer.root));
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });
		const plan = await engine.plan(current, target);
		const driftRoot = await createNestedRepo(outer.root, "drift-root");

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(outer.root, "file.txt"), "utf8")).toBe("current\n");
		expect((await lstat(join(driftRoot.root, ".git"))).isDirectory()).toBe(true);
		expect((await discovery.discover(outer.root)).roots.map((root) => root.relativeRoot)).toEqual([
			".",
			"drift-root",
		]);
	});

	it("plan 后对象闭包损坏时零 mutation fail-safe 并释放 pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new ToggleIncompleteSnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);
		store.failCompleteness = true;

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("expected plan 重算遇到非对象缺失错误时抛出并清理 attempt pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new ToggleListTreeFailureSnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);
		store.failListTree = true;

		await expect(engine.apply(plan, target)).rejects.toThrow("listTree 契约错误");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it.each([".git", ".GIT/config"])("损坏 tree 含 Git metadata 路径 %s 时在 plan 阶段 fail-closed", async (gitPath) => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new GitMetadataTreeSnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		store.gitMetadataPath = gitPath;
		store.injectGitMetadata = true;

		await expect(engine.plan(current, target)).rejects.toThrow("Git metadata");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
	});

	it("rollback 报错但完整 current 状态可证明时返回 safe", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "a.txt", "target\n");
		await writeFile(workspace, "target-only.txt", "target-only\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "a.txt", "current\n");
		await rm(join(workspace, "target-only.txt"));
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: (mutation) => {
				if (mutation.ordinal === 1) {
					throw new Error(`注入 ${mutation.phase} mutation 失败`);
				}
			},
		});
		const plan = await engine.plan(current, target);

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("restore_failed_safe");
		expect(result.postFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current\n");
		await expect(access(join(workspace, "target-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("active 到 uninitialized submodule 仅删除普通内容并保留 Git metadata", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/child");
		temporaryRoots.push(child.sourceRoot);
		const heldRoot = await temporaryRoot("pi-undo-held-submodule-");
		const heldChild = join(heldRoot, "child");
		await rename(child.root, heldChild);
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		expect(target.roots.find((root) => root.relativeRoot === "modules/child")?.state).toBe("uninitialized");

		await rename(heldChild, child.root);
		await writeFile(child.root, "managed.txt", "remove-me\n");
		const current = await store.capture(await discovery.discover(outer.root));
		expect(current.roots.find((root) => root.relativeRoot === "modules/child")?.state).toBe("active");
		const outerMetadata = await readGitMetadata(outer.root);
		const childMetadata = await readGitMetadata(child.root);
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("ok");
		await expect(access(join(child.root, "managed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(join(child.root, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(join(child.root, ".git"))).isFile()).toBe(true);
		expect((await discovery.discover(outer.root)).roots.find(
			(root) => root.relativeRoot === "modules/child",
		)?.state).toBe("active");
		expect(await readGitMetadata(outer.root)).toEqual(outerMetadata);
		expect(await readGitMetadata(child.root)).toEqual(childMetadata);
	});

	it("uninitialized 到 active submodule 在 mutation 前 fail-safe", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/child");
		temporaryRoots.push(child.sourceRoot);
		await writeFile(child.root, "target-only.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		const heldRoot = await temporaryRoot("pi-undo-held-submodule-");
		const heldChild = join(heldRoot, "child");
		await rename(child.root, heldChild);
		const current = await store.capture(await discovery.discover(outer.root));
		expect(current.roots.find((root) => root.relativeRoot === "modules/child")?.state).toBe("uninitialized");
		const outerMetadata = await readGitMetadata(outer.root);
		const engine = new RestoreEngine({ workspaceRoot: outer.root, store, discovery });

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		await expect(access(child.root)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(join(heldChild, ".git"))).isFile()).toBe(true);
		expect(await readFile(join(heldChild, "target-only.txt"), "utf8")).toBe("target\n");
		expect(await readGitMetadata(outer.root)).toEqual(outerMetadata);
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("拒绝重新计算 digest 的 boundary plan 篡改并清理 pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const original = await engine.plan(current, target);
		const semanticPlan = {
			currentManifestId: original.currentManifestId,
			targetManifestId: original.targetManifestId,
			boundaryRoots: [".", "outside-root"],
			deletePaths: original.deletePaths,
			writePaths: original.writePaths,
		};
		const tampered = {
			...semanticPlan,
			planDigest: checksum(canonicalJson(semanticPlan)),
		};

		await expect(engine.apply(tampered, target)).rejects.toThrow("篡改");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("拒绝跨 workspace current manifest 的重签名 plan 并清理 pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		const otherWorkspace = await temporaryRoot("pi-undo-restore-other-");
		await writeFile(workspace, "file.txt", "target\n");
		await writeFile(otherWorkspace, "file.txt", "other\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const otherCurrent = await store.capture(await discovery.discover(otherWorkspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const original = await engine.plan(current, target);
		const semanticPlan = {
			currentManifestId: otherCurrent.manifestId,
			targetManifestId: original.targetManifestId,
			boundaryRoots: original.boundaryRoots,
			deletePaths: original.deletePaths,
			writePaths: original.writePaths,
		};
		const corrupted = {
			...semanticPlan,
			planDigest: checksum(canonicalJson(semanticPlan)),
		};

		await expect(engine.apply(corrupted, target)).rejects.toThrow("同一 workspace");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("入口拒绝 invalid plan/target 且零 mutation、零 pin", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		let mutations = 0;
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: () => {
				mutations += 1;
			},
		});
		const plan = await engine.plan(current, target);

		await expect(engine.apply({ ...plan, targetManifestId: current.manifestId }, target)).rejects.toThrow(
			"target manifest ID 不匹配",
		);
		await expect(engine.apply({ ...plan, planDigest: "invalid" }, target)).rejects.toThrow("digest 无效");
		await expect(engine.apply(plan, { ...target, coverage: "invalid" })).rejects.toThrow("coverage 无效");
		await expect(engine.apply(plan, withActiveNullTree(target))).rejects.toMatchObject({
			code: "invalid_manifest",
		});
		expect(mutations).toBe(0);
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect((await filesBelow(storeRoot)).filter((path) => path.includes("/pins/"))).toEqual([]);
	});

	it("current 或 target 含 broken root 时 plan fail-closed", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });

		await expect(engine.plan(withBrokenRoot(current), target)).rejects.toThrow("broken root");
		await expect(engine.plan(current, withBrokenRoot(target))).rejects.toThrow("broken root");
	});

	it("拒绝 current 与 target 的 opaque coverage 不一致", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "scoped.txt", "target\n");
		await writeFile(workspace, "outside.txt", "outside\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "scoped.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace), ["scoped.txt"]);
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });

		await expect(engine.plan(current, target)).rejects.toThrow("coverage 不一致");
		expect(await readFile(join(workspace, "outside.txt"), "utf8")).toBe("outside\n");
	});

	it("partial coverage 恢复时保留 scope 外与 ignored 文件的最新内容", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, ".gitignore", "ignored.txt\n");
		await writeFile(workspace, "scoped.txt", "target\n");
		await writeFile(workspace, "outside.txt", "outside-before\n");
		await writeFile(workspace, "ignored.txt", "ignored-before\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const scope = ["scoped.txt"];
		const target = await store.capture(await discovery.discover(workspace), scope);
		await writeFile(workspace, "scoped.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace), scope);
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);
		await writeFile(workspace, "outside.txt", "outside-latest\n");
		await writeFile(workspace, "ignored.txt", "ignored-latest\n");

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("ok");
		expect(await readFile(join(workspace, "scoped.txt"), "utf8")).toBe("target\n");
		expect(await readFile(join(workspace, "outside.txt"), "utf8")).toBe("outside-latest\n");
		expect(await readFile(join(workspace, "ignored.txt"), "utf8")).toBe("ignored-latest\n");
	});

	it("current ignored 路径已等于 target visible 内容时不触碰该叶子", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, ".gitignore", "");
		await writeFile(workspace, "promoted.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, ".gitignore", "promoted.txt\n");
		const current = await store.capture(await discovery.discover(workspace));
		const mutatedPaths: string[] = [];
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: (mutation) => {
				if (mutation.phase === "apply") {
					mutatedPaths.push(mutation.path);
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("ok");
		expect(mutatedPaths).toEqual([".gitignore"]);
		expect(await readFile(join(workspace, "promoted.txt"), "utf8")).toBe("target\n");
	});

	it.each(["delete", "write"] as const)("%s syscall 前拒绝 hook 注入的第三态", async (operation) => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		if (operation === "write") {
			await writeFile(workspace, "victim.txt", "target\n");
		}
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "victim.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await writeFile(workspace, "victim.txt", "third-state\n");
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(["partial_restore", "recovery_required"]).toContain(result.code);
		expect(await readFile(join(workspace, "victim.txt"), "utf8")).toBe("third-state\n");
	});

	it("mutation 前中间目录被换成 symlink 时不越界并安全 rollback", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		const outside = await temporaryRoot("pi-undo-restore-outside-");
		await writeFile(workspace, "safe/file.txt", "target\n");
		await writeFile(outside, "file.txt", "outside\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "safe/file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const safeDirectory = join(workspace, "safe");
		const heldDirectory = join(workspace, "safe-held");
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await rename(safeDirectory, heldDirectory);
					await symlink(outside, safeDirectory, "dir");
				}
				if (mutation.phase === "rollback" && mutation.ordinal === 1) {
					await rm(safeDirectory);
					await rename(heldDirectory, safeDirectory);
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(workspace, "safe/file.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("outside\n");
		expect((await lstat(safeDirectory)).isDirectory()).toBe(true);
	});

	it("post topology drift 触发 rollback 并再次验证 current", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		await writeFile(outer.root, "file.txt", "target\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		await writeFile(outer.root, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(outer.root));
		const metadataBefore = await readGitMetadata(outer.root);
		const driftPath = join(outer.root, "post-drift");
		const engine = new RestoreEngine({
			workspaceRoot: outer.root,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await createNestedRepo(outer.root, "post-drift");
				}
				if (mutation.phase === "rollback" && mutation.ordinal === 1) {
					await rm(driftPath, { recursive: true });
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(await readFile(join(outer.root, "file.txt"), "utf8")).toBe("current\n");
		await expect(access(driftPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readGitMetadata(outer.root)).toEqual(metadataBefore);
	});

	it("同时恢复 outer 与 initialized submodule 且父 root 先写", async () => {
		const outer = await createGitRepo();
		temporaryRoots.push(outer.root);
		const child = await createLocalSubmodule(outer.root, "modules/child");
		temporaryRoots.push(child.sourceRoot);
		await writeFile(outer.root, "outer.txt", "target-outer\n");
		await writeFile(child.root, "child.txt", "target-child\n");
		await writeFile(child.root, "README.md", "target-readme\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(outer.root));
		await writeFile(outer.root, "outer.txt", "current-outer\n");
		await writeFile(child.root, "child.txt", "current-child\n");
		await writeFile(child.root, "README.md", "current-readme\n");
		const current = await store.capture(await discovery.discover(outer.root));
		const outerMetadata = await readGitMetadata(outer.root);
		const childMetadata = await readGitMetadata(child.root);
		const applyMutations: string[] = [];
		const engine = new RestoreEngine({
			workspaceRoot: outer.root,
			store,
			discovery,
			beforeMutation: (mutation) => {
				if (mutation.phase === "apply") {
					applyMutations.push(mutation.path);
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("ok");
		expect(applyMutations).toEqual([
			"outer.txt",
			"modules/child/README.md",
			"modules/child/child.txt",
		]);
		expect(await readFile(join(outer.root, "outer.txt"), "utf8")).toBe("target-outer\n");
		expect(await readFile(join(child.root, "README.md"), "utf8")).toBe("target-readme\n");
		expect(await readFile(join(child.root, "child.txt"), "utf8")).toBe("target-child\n");
		expect(await readGitMetadata(outer.root)).toEqual(outerMetadata);
		expect(await readGitMetadata(child.root)).toEqual(childMetadata);
	});

	it("同一 plan 完整成功后可幂等 replay 到 target", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "changed.txt", "target\n");
		await writeFile(workspace, "target-only.txt", "target-only\n");
		await writeFile(workspace, "kind-node", "target-file\n");
		await symlink("changed.txt", join(workspace, "target-only-link"));
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "changed.txt", "current\n");
		await rm(join(workspace, "target-only.txt"));
		await rm(join(workspace, "target-only-link"));
		await rm(join(workspace, "kind-node"));
		await writeFile(workspace, "kind-node/child.txt", "current-child\n");
		await writeFile(workspace, "current-only.txt", "current-only\n");
		const current = await store.capture(await discovery.discover(workspace));
		const mutations: string[] = [];
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: (mutation) => {
				mutations.push(`${mutation.phase}:${mutation.kind}:${mutation.path}`);
			},
		});
		const plan = await engine.plan(current, target);

		expect((await engine.apply(plan, target)).code).toBe("ok");
		mutations.length = 0;
		const replay = await engine.apply(plan, target);

		expect(mutations).toEqual([
			"apply:delete:kind-node",
			"apply:write:changed.txt",
			"apply:write:kind-node",
			"apply:write:target-only.txt",
		]);
		expect(replay.code).toBe("ok");
		expect(replay.verifiedPaths).toBe(replay.totalPaths);
		expect(await readFile(join(workspace, "changed.txt"), "utf8")).toBe("target\n");
		expect(await readFile(join(workspace, "target-only.txt"), "utf8")).toBe("target-only\n");
		expect(await readlink(join(workspace, "target-only-link"))).toBe("changed.txt");
		expect(await readFile(join(workspace, "kind-node"), "utf8")).toBe("target-file\n");
		await expect(access(join(workspace, "current-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("directory 恢复为 symlink 后同一 plan 可幂等 replay", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "link-target/kept.txt", "target\n");
		await symlink("link-target", join(workspace, "kind-node"), "dir");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await rm(join(workspace, "kind-node"));
		await writeFile(workspace, "kind-node/old.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);

		expect((await engine.apply(plan, target)).code).toBe("ok");
		expect((await engine.apply(plan, target)).code).toBe("ok");
		expect(await readlink(join(workspace, "kind-node"))).toBe("link-target");
		expect(await readFile(join(workspace, "link-target/kept.txt"), "utf8")).toBe("target\n");
	});

	it("current/target 混合前缀可 replay 并 roll-forward 到 target", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		await writeFile(workspace, "a.txt", "target-a\n");
		await writeFile(workspace, "b.txt", "target-b\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "a.txt", "current-a\n");
		await writeFile(workspace, "b.txt", "current-b\n");
		const current = await store.capture(await discovery.discover(workspace));
		const engine = new RestoreEngine({ workspaceRoot: workspace, store, discovery });
		const plan = await engine.plan(current, target);
		await writeFile(workspace, "a.txt", "target-a\n");

		const result = await engine.apply(plan, target);

		expect(result.code).toBe("ok");
		expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("target-a\n");
		expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("target-b\n");
	});

	it("workspace symlink alias 可用且 hook 后换向外部时 fail-safe", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		const outside = await temporaryRoot("pi-undo-restore-outside-");
		const aliasParent = await temporaryRoot("pi-undo-restore-alias-");
		const alias = join(aliasParent, "workspace-alias");
		await symlink(workspace, alias, "dir");
		await writeFile(workspace, "file.txt", "target\n");
		await writeFile(outside, "file.txt", "outside-sentinel\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		let mutationHookCalls = 0;
		const engine = new RestoreEngine({
			workspaceRoot: alias,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply") {
					mutationHookCalls += 1;
					await rm(alias);
					await symlink(outside, alias, "dir");
				}
				if (mutation.phase === "rollback") {
					await rm(alias);
					await symlink(workspace, alias, "dir");
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(mutationHookCalls).toBe(1);
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("outside-sentinel\n");
	});

	it("canonical workspace root 在 preflight 后换向也不能写到外部", async () => {
		const workspace = await temporaryRoot("pi-undo-restore-workspace-");
		const outside = await temporaryRoot("pi-undo-restore-outside-");
		const heldParent = await temporaryRoot("pi-undo-held-workspace-");
		const heldWorkspace = join(heldParent, "workspace");
		await writeFile(workspace, "file.txt", "target\n");
		await writeFile(outside, "file.txt", "outside-sentinel\n");
		const storeRoot = await temporaryRoot("pi-undo-restore-store-");
		const discovery = new RootDiscovery();
		const store = new SnapshotStore({ storeRoot });
		const target = await store.capture(await discovery.discover(workspace));
		await writeFile(workspace, "file.txt", "current\n");
		const current = await store.capture(await discovery.discover(workspace));
		let outsideBeforeRollback: string | undefined;
		const engine = new RestoreEngine({
			workspaceRoot: workspace,
			store,
			discovery,
			beforeMutation: async (mutation) => {
				if (mutation.phase === "apply" && mutation.ordinal === 1) {
					await rename(workspace, heldWorkspace);
					await symlink(outside, workspace, "dir");
				}
				if (mutation.phase === "rollback" && mutation.ordinal === 1) {
					outsideBeforeRollback = await readFile(join(outside, "file.txt"), "utf8");
					await rm(workspace);
					await rename(heldWorkspace, workspace);
				}
			},
		});

		const result = await engine.apply(await engine.plan(current, target), target);

		expect(result.code).toBe("restore_failed_safe");
		expect(outsideBeforeRollback).toBe("outside-sentinel\n");
		expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("current\n");
		expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("outside-sentinel\n");
	});
});
