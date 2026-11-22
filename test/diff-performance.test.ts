import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { compareDiffText } from "../src/diff-text.ts";
import { computeCheckpointDiff, prepareCheckpointDiff } from "../src/diff-view.ts";
import { GitRunner, type GitRunOptions } from "../src/git-runner.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { writeFile } from "./fixtures.ts";

class CountingGitRunner extends GitRunner {
	readonly calls: string[] = [];

	override run(args: readonly string[], options?: GitRunOptions) {
		this.calls.push(args[0]!);
		return super.run(args, options);
	}
}

function median(samples: number[]) {
	return Number([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!.toFixed(2));
}

// 每次新建 Store 以清空应用内缓存。计时仅覆盖读取与计算，断言调用次数和结果。
describe.skipIf(process.env.PI_UNDO_DIFF_BENCH !== "1")("/diff 性能", () => {
	it("3100 个文件中修改 100 个，分别测列表、单文件、摘要和全部正文", async () => {
		const temp = await mkdtemp(join(tmpdir(), "pi-undo-diff-bench-"));
		const workspace = join(temp, "workspace");
		const storeRoot = join(temp, "store");
		const discovery = new RootDiscovery();
		try {
			const paths = Array.from({ length: 3_100 }, (_, i) => `file-${i}.txt`);
			const changedPaths = paths.slice(0, 100);
			for (let start = 0; start < paths.length; start += 64) {
				await Promise.all(paths.slice(start, start + 64).map((p) => writeFile(workspace, p, `before ${p}\n`)));
			}
			const topology = await discovery.discover(workspace);
			const store = new SnapshotStore({ storeRoot, discovery });
			const before = await store.capture(topology);
			await Promise.all(changedPaths.map((p) => writeFile(workspace, p, `after ${p}\n`)));
			const after = await store.capture(topology);
			const request = { beforeManifestId: before.manifestId, afterManifestId: after.manifestId, changedPaths };
			// 可选：指向装好依赖的旧版 checkout，在同一对快照上交替运行真实旧实现。
			const oldDir = process.env.PI_UNDO_DIFF_BASELINE_DIR;
			const baseline: typeof computeCheckpointDiff | undefined = oldDir &&
				(await import(/* @vite-ignore */ pathToFileURL(resolve(oldDir, "src/diff-view.ts")).href)).computeCheckpointDiff;
			const samples = new Map<string, number[]>();
			const gitCalls = new Map<string, number>();
			const measure = async <T>(name: string, git: CountingGitRunner, run: () => Promise<T>) => {
				const calls = git.calls.length;
				const start = performance.now();
				const result = await run();
				const ms = performance.now() - start;
				const group = samples.get(name) ?? [];
				group.push(ms);
				samples.set(name, group);
				gitCalls.set(name, git.calls.length - calls);
				return result;
			};
			for (let i = 0; i < 5; i++) {
				const modes = ["优化后全部", ...(baseline ? ["优化前全部"] : [])];
				for (const mode of i % 2 === 0 ? modes : modes.reverse()) {
					const git = new CountingGitRunner();
					const source = new SnapshotStore({ storeRoot, git });
					const compute = mode === "优化前全部" ? baseline! : computeCheckpointDiff;
					const diffs = await measure(mode, git, () => compute(source, request));
					expect(diffs.map((d) => d.path)).toEqual(changedPaths);
					for (const diff of diffs) expect(diff.diff).toBe(`-1 before ${diff.path}\n+1 after ${diff.path}`);
					if (mode === "优化后全部") expect(git.calls).toEqual(["ls-tree", "ls-tree", "cat-file", "cat-file"]);
				}
				const git = new CountingGitRunner();
				const view = await measure("文件列表", git, () => prepareCheckpointDiff(new SnapshotStore({ storeRoot, git }), request));
				expect(git.calls).toEqual(["ls-tree", "ls-tree"]);
				const file = await measure("从列表打开一个文件", git, () => view.loadFile(view.files[0]!));
				expect(file).toMatchObject({ additions: 1, deletions: 1 });
				const summaryGit = new CountingGitRunner();
				const summary = await measure("非 TUI 摘要", summaryGit, async () =>
					(await prepareCheckpointDiff(new SnapshotStore({ storeRoot, git: summaryGit }), request)).summary());
				expect(summary).toContain("100 file(s), +100 -100");
			}
			for (const [name, times] of samples) console.log({ name, medianMs: median(times), gitCalls: gitCalls.get(name) });
		} finally {
			await discovery.dispose();
			await rm(temp, { recursive: true, force: true });
		}
	}, 120_000);

	it("比较局部修改和整文件重写的逐行计算", () => {
		for (const rewritten of [false, true]) {
			const lines = Array.from({ length: rewritten ? 3_000 : 20_000 }, (_, i) => `line ${i}\n`);
			const before = lines.join("");
			const after = rewritten ? before.replaceAll("line", "new") : before.replace("line 9000\n", "changed\n");
			const oldTimes = [];
			const times = [];
			for (let i = 0; i < 5; i++) {
				const start = performance.now();
				const original = generateDiffString(before, after).diff;
				const middle = performance.now();
				const result = compareDiffText(before, after);
				times.push(performance.now() - middle);
				oldTimes.push(middle - start);
				expect(result.diff).toBe(original);
			}
			console.log({ name: rewritten ? "3000 行全部重写" : "20000 行改一行", oldMs: median(oldTimes), newMs: median(times) });
		}
	});
});
