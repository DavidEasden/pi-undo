import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitRunner } from "../src/git-runner.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { createGitRepo } from "./fixtures.ts";

/** 以 Git 精确结果作独立基准；只记录实际耗时，不设置墙钟门槛。 */
describe.skipIf(process.env.PI_UNDO_IGNORED_BENCHMARK !== "1")("忽略文件证明端到端基准", () => {
	it("记录完整捕获与 baseline 检查的冷、热耗时", async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-ignored-bench-")));
		const workspace = join(base, "workspace");
		const packages = Number(process.env.PI_UNDO_BENCH_PACKAGES ?? "10000");
		if (!Number.isSafeInteger(packages) || packages < 1 || packages > 10000) throw new Error("基准规模必须在 1–10000 之间");
		const git = new GitRunner();
		const discovery = new RootDiscovery(git);
		const store = new SnapshotStore({ storeRoot: join(base, "store"), discovery, git });
		try {
			await createGitRepo(workspace);
			await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
			for (let start = 0; start < packages; start += 64) {
				await Promise.all(Array.from({ length: Math.min(64, packages - start) }, async (_, index) => {
					const path = join(workspace, "node_modules", `p${start + index}`, "lib");
					await mkdir(path, { recursive: true });
					await writeFile(join(path, "index.js"), "内容\n");
				}));
			}
			// 造数不计时，先越过既有 racy 窗口，保证各轮 baseline 检查处于同一状态。
			await new Promise((resolve) => setTimeout(resolve, 2_100));
			const expected = (await git.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: workspace }))
				.stdout.split("\0").filter(Boolean).sort();
			const samples: Array<{ round: number; discoveryMs: number; captureMs: number; baselineMs: number }> = [];
			for (let round = 0; round < 6; round += 1) {
				let started = performance.now();
				const topology = await discovery.discover(workspace);
				const discoveryMs = performance.now() - started;
				started = performance.now();
				const manifest = await store.capture(topology, undefined, { topologyAlreadyValidated: true, skipPostTopologyCheck: true });
				const captureMs = performance.now() - started;
				expect(manifest.roots[0]?.ignoredPresentPaths).toEqual(expected);
				started = performance.now();
				const settled = await store.captureBaseline(topology, manifest, undefined, { topologyAlreadyValidated: true, skipPostTopologyCheck: true });
				const baselineMs = performance.now() - started;
				expect(settled.roots[0]?.ignoredPresentPaths).toEqual(expected);
				samples.push({ round, discoveryMs, captureMs, baselineMs });
			}
			const report = JSON.stringify({ benchmark: "ignored-proof", packages, platform: process.platform, samples });
			console.log(report);
			if (process.env.PI_UNDO_BENCH_REPORT !== undefined) await appendFile(process.env.PI_UNDO_BENCH_REPORT, `${report}\n`);
		} finally {
			await discovery.dispose();
			await rm(base, { recursive: true, force: true });
		}
	}, 180_000);
});
