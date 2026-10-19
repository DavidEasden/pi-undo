import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDurablePack, type DurablePackEntryInput } from "../src/durable-pack.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { fingerprintBytes } from "../src/quarantine.ts";

// 每次以独立测试进程运行，避免把造数、capture 或前一轮 GC 累积计入 pack。
describe.skipIf(process.env.PI_UNDO_PACK_MEMORY_BENCHMARK !== "1")("pack 私有副本内存基准", () => {
	it("64 MiB payload 的阶段内存增量", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-pack-memory-"));
		try {
			const entries: DurablePackEntryInput[] = Array.from({ length: 16 }, (_, index) => {
				const path = `file-${index}.bin`;
				const bytes = Buffer.alloc(4 * 1024 * 1024, index);
				const fingerprint = fingerprintBytes(path, bytes, 0o644);
				const artifact = index.toString(16).padStart(32, "0");
				return {
					path, sourceArtifact: `.pi-undo-q2-${artifact}-source`, targetArtifact: null,
					sourceFingerprint: fingerprint, targetFingerprint: fingerprint,
					variants: [{ kind: "file", bytes, fingerprint, mode: 0o644 }],
				};
			});
			const before = process.memoryUsage();
			const phases: Array<{ phase: string; durationMs: number; arrayBuffersDeltaMiB: number; rssDeltaMiB: number }> = [];
			const started = performance.now();
			const pack = await createDurablePack(new MutationJournal(join(root, "mutations.jsonl"), "memory-benchmark"), {
				opId: "memory-benchmark", planDigest: "a".repeat(64), entries,
			}, {
				onTiming: (phase, durationMs) => {
					const current = process.memoryUsage();
					phases.push({ phase, durationMs,
						arrayBuffersDeltaMiB: (current.arrayBuffers - before.arrayBuffers) / 1024 / 1024,
						rssDeltaMiB: (current.rss - before.rss) / 1024 / 1024 });
				},
			});
			console.log(JSON.stringify({ benchmark: "pack-memory", payloadMiB: 64,
				durationMs: performance.now() - started, phases,
				// 阶段边界观测值，不宣称捕获同步计算期间的瞬时峰值。
				maxObservedArrayBuffersDeltaMiB: Math.max(...phases.map((phase) => phase.arrayBuffersDeltaMiB)),
				maxObservedRssDeltaMiB: Math.max(...phases.map((phase) => phase.rssDeltaMiB)),
			}));
			expect(pack.paths()).toHaveLength(entries.length);
			const leaf = pack.leaf(entries[0]!.path, entries[0]!.sourceFingerprint);
			expect(leaf?.kind === "file" && leaf.bytes.length).toBe(4 * 1024 * 1024);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
