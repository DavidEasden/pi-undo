import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DurablePackWriteDiagnostic } from "../src/durable-pack.ts";
import { RestoreEngine } from "../src/restore-engine.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

// 按需基准：准备时间不包含造数、capture、apply 和清理；不设墙钟断言。
describe.skipIf(process.env.PI_UNDO_PACK_BENCHMARK !== "1")("durable pack 准备基准", () => {
	it.each([
		{ name: "10001 个小文件", count: 10_001, size: 64 },
		{ name: "8 个大文件", count: 8, size: 4 * 1024 * 1024 },
	])("$name：冷缓存与热缓存各三次", async ({ name, count, size }) => {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-pack-benchmark-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-pack-benchmark-store-"));
		try {
			const paths = Array.from({ length: count }, (_, index) => `file-${String(index).padStart(5, "0")}.txt`);
			const populate = async (value: number): Promise<void> => {
				for (let start = 0; start < paths.length; start += 32) {
					await Promise.all(paths.slice(start, start + 32).map(async (path, offset) => {
						const bytes = Buffer.alloc(size, value);
						bytes.writeUInt32LE(start + offset, 0);
						await writeFile(join(root, path), bytes);
					}));
				}
			};
			const discovery = new RootDiscovery();
			const captureStore = new SnapshotStore({ storeRoot, discovery });
			const topology = await discovery.discover(root);
			await populate(65);
			const before = await captureStore.capture(topology);
			await populate(66);
			const after = await captureStore.capture(topology, paths);
			for (let sample = 1; sample <= 3; sample += 1) {
				// 冷缓存指新 SnapshotStore 的进程内缓存，不清除操作系统页缓存。
				const store = new SnapshotStore({ storeRoot, discovery });
				const restore = new RestoreEngine({ workspaceRoot: root, store, discovery });
				for (const cache of ["cold", "warm"] as const) {
					const timings: Record<string, number> = {};
					let diagnostic: DurablePackWriteDiagnostic | undefined;
					const started = performance.now();
					await restore.prepareDurableRestore(after, before, paths, {
						onTiming: (phase, durationMs) => { timings[phase] = durationMs; },
						onDiagnostics: (value) => { diagnostic = value; },
					});
					const durationMs = performance.now() - started;
					expect(diagnostic?.entries).toBe(count);
					expect(diagnostic?.fileVariants).toBe(2 * count);
					expect(diagnostic?.payloadBytes).toBe(2 * count * size);
					console.log(JSON.stringify({
						benchmark: "durable-pack-prepare", name, cache, sample, durationMs,
						timings, ...diagnostic,
						rssMiB: process.memoryUsage().rss / 1024 / 1024,
						// 这是整个测试进程的高水位，包含造数与 capture，不能归因于单次 prepare。
						processPeakRssMiB: process.resourceUsage().maxRSS / 1024,
					}));
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true });
		}
	}, 180_000);
});
