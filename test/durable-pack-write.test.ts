import { mkdtemp, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDurablePack, durablePackPath, loadDurablePack, type DurablePackEntryInput, type DurablePackInput, type DurablePackWriteDiagnostic } from "../src/durable-pack.ts";
import { checksum } from "../src/encoding.ts";
import { MutationJournal } from "../src/mutation-journal.ts";
import { createOperationScope, runWithOperationContext } from "../src/operation-context.ts";
import { fingerprintAbsent, fingerprintBytes, fingerprintSymlink } from "../src/quarantine.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
const legacyUrl = new URL("./fixtures/durable-pack-v1.bin", import.meta.url);

afterEach(async () => {
	vi.mocked(open).mockReset().mockImplementation(actualFs.open);
	vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<MutationJournal> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-pack-write-"));
	roots.push(root);
	return new MutationJournal(join(root, "mutations.jsonl"), "operation-1");
}

// 此输入对应批量写入改动之前生成的 v1 fixture，覆盖空文件、mode、二进制内容和 symlink。
function legacyInput(): DurablePackInput {
	const entries: DurablePackEntryInput[] = ["empty.txt", "value.txt"].map((path, index) => {
		const source = Buffer.from(index === 0 ? "" : "旧内容\n");
		const target = Buffer.from(index === 0 ? "" : "新内容\0\n");
		const sourceFingerprint = fingerprintBytes(path, source, 0o644);
		const targetFingerprint = fingerprintBytes(path, target, 0o755);
		const absent = fingerprintAbsent(path);
		const artifact = String(index + 1).repeat(32);
		return {
			path, sourceArtifact: `.pi-undo-q2-${artifact}-source`, targetArtifact: `.pi-undo-q2-${artifact}-target`,
			sourceFingerprint, targetFingerprint,
			variants: [
				{ kind: "absent", fingerprint: absent },
				{ kind: "file", fingerprint: sourceFingerprint, mode: 0o644, bytes: source },
				{ kind: "file", fingerprint: targetFingerprint, mode: 0o755, bytes: target },
			],
		};
	});
	const fingerprint = fingerprintSymlink("link", "value.txt");
	entries.push({
		path: "link", sourceArtifact: `.pi-undo-q2-${"3".repeat(32)}-source`, targetArtifact: null,
		sourceFingerprint: fingerprint, targetFingerprint: fingerprint,
		variants: [{ kind: "symlink", fingerprint, linkText: "value.txt" }],
	});
	return { opId: "operation-1", planDigest: "a".repeat(64), entries };
}

function interceptTemporary(setup: (handle: FileHandle) => void): void {
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await actualFs.open(...args);
		if (String(args[0]).endsWith(".tmp")) setup(handle);
		return handle;
	});
}

function prefixBuffers(buffers: readonly NodeJS.ArrayBufferView[], limit: number): Buffer[] {
	const result: Buffer[] = [];
	for (const buffer of buffers) {
		if (limit === 0) break;
		const length = Math.min(limit, buffer.byteLength);
		result.push(Buffer.from(buffer.buffer, buffer.byteOffset, length));
		limit -= length;
	}
	return result;
}

describe("durable pack 批量写入", () => {
	it("兼容旧 v1 pack，重新生成的文件逐字节一致且诊断异常不影响结果", async () => {
		const journal = await fixture();
		const legacy = await readFile(legacyUrl);
		expect(checksum(legacy)).toBe("d11a4364cee3b347116cf8c3f6cc598baddc593b778f3ee81f24568546f57b4e");
		await writeFile(durablePackPath(journal), legacy);
		const loaded = await loadDurablePack(journal, "a".repeat(64));
		expect(loaded.paths()).toEqual(["empty.txt", "link", "value.txt"]);
		const pack = await createDurablePack(journal, legacyInput(), {
			onTiming: () => { throw new Error("注入计时回调失败"); },
			onDiagnostics: () => { throw new Error("注入统计回调失败"); },
		});
		expect(await readFile(pack.storagePath)).toEqual(legacy);
		expect(pack.packChecksum).toBe(loaded.packChecksum);
	});

	it.each(["pack.validate", "pack.write"])("%s 后改写输入不影响磁盘、驻留与返回副本", async (phase) => {
		const journal = await fixture();
		const input = legacyInput();
		const expected = legacyInput();
		const pack = await createDurablePack(journal, input, {
			onTiming: (label) => {
				if (label !== phase) return;
				for (const entry of input.entries) {
					for (const variant of entry.variants) {
						if (variant.kind === "file") variant.bytes.fill(0xff);
						if (variant.kind === "symlink") Object.assign(variant, { linkText: "changed" });
					}
				}
				Object.assign(input, { opId: "changed", planDigest: "f".repeat(64) });
			},
		});
		expect(await readFile(pack.storagePath)).toEqual(await readFile(legacyUrl));
		const loaded = await loadDurablePack(journal, expected.planDigest);
		expect(pack.opId).toBe(expected.opId);
		expect(pack.planDigest).toBe(expected.planDigest);
		expect(pack.packChecksum).toBe(loaded.packChecksum);
		for (const entry of expected.entries) {
			for (const variant of entry.variants) {
				const leaf = pack.leaf(entry.path, variant.fingerprint);
				expect(leaf).toEqual(loaded.leaf(entry.path, variant.fingerprint));
				if (leaf?.kind === "file") leaf.bytes.fill(0x7f);
				expect(pack.leaf(entry.path, variant.fingerprint)).toEqual(loaded.leaf(entry.path, variant.fingerprint));
			}
		}
	});

	it("跨 buffer、buffer 内与边界短写均重试到完整 pack", async () => {
		const journal = await fixture();
		let calls = 0;
		interceptTemporary((handle) => {
			const original = handle.writev.bind(handle);
			handle.writev = async (buffers, position) => {
				const limit = [1, 13, 5, 7, 2048, 9, 4096][calls++] ?? 4096;
				const result = await original(prefixBuffers(buffers, limit), position);
				return { bytesWritten: result.bytesWritten, buffers };
			};
		});
		let diagnostic: DurablePackWriteDiagnostic | undefined;
		const pack = await createDurablePack(journal, legacyInput(), { onDiagnostics: (value) => { diagnostic = value; } });
		expect(calls).toBeGreaterThan(4);
		expect(diagnostic?.writeCalls).toBe(calls);
		expect(await readFile(pack.storagePath)).toEqual(await readFile(legacyUrl));
		expect((await loadDurablePack(journal)).packChecksum).toBe(pack.packChecksum);
	});

	it("大量小 payload 和单个超限 payload 同时受 buffer 数量与字节上限约束", async () => {
		const journal = await fixture();
		const entries: DurablePackEntryInput[] = Array.from({ length: 601 }, (_, index) => {
			const path = `file-${String(index).padStart(4, "0")}`;
			const bytes = Buffer.alloc(index === 600 ? 9 * 1024 * 1024 : 64, index % 251);
			const fingerprint = fingerprintBytes(path, bytes, 0o644);
			const artifact = index.toString(16).padStart(32, "0");
			return {
				path, sourceArtifact: `.pi-undo-q2-${artifact}-source`, targetArtifact: `.pi-undo-q2-${artifact}-target`,
				sourceFingerprint: fingerprint, targetFingerprint: fingerprint,
				variants: [{ kind: "file", fingerprint, mode: 0o644, bytes }],
			};
		});
		const batches: Array<{ count: number; bytes: number }> = [];
		interceptTemporary((handle) => {
			const original = handle.writev.bind(handle);
			handle.writev = async (buffers, position) => {
				batches.push({ count: buffers.length, bytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0) });
				return original(buffers, position);
			};
		});
		let diagnostic: DurablePackWriteDiagnostic | undefined;
		const timings: Record<string, number> = {};
		const pack = await createDurablePack(journal, { ...legacyInput(), entries }, {
			onTiming: (phase, ms) => { timings[phase] = ms; },
			onDiagnostics: (value) => { diagnostic = value; },
		});
		expect(batches.length).toBeLessThan(10);
		expect(batches.some((batch) => batch.count === 256)).toBe(true);
		expect(batches.some((batch) => batch.bytes === 4 * 1024 * 1024)).toBe(true);
		for (const batch of batches) {
			expect(batch.count).toBeLessThanOrEqual(256);
			expect(batch.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		}
		const bytes = await readFile(pack.storagePath);
		expect(diagnostic).toEqual({ entries: 601, fileVariants: 601, payloadBytes: 600 * 64 + 9 * 1024 * 1024, packBytes: bytes.length, writeCalls: batches.length });
		expect(Object.keys(timings)).toEqual(["pack.validate", "pack.encode", "pack.write", "pack.sync", "pack.publish", "pack.checksum", "pack.resident"]);
		expect(Object.values(timings).every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
		expect(pack.packChecksum).toBe(checksum(bytes));
		const loaded = await loadDurablePack(journal);
		for (const entry of entries) {
			const expected = entry.variants[0]!;
			const actual = loaded.leaf(entry.path, entry.sourceFingerprint);
			expect(actual?.kind).toBe("file");
			if (expected.kind !== "file" || actual?.kind !== "file") throw new Error("缺少 file variant");
			expect(actual.fingerprint).toBe(expected.fingerprint);
			expect(actual.mode).toBe(expected.mode);
			expect(Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes))).toBe(true);
		}
	});

	it.each([
		{ failure: "zero", existing: false },
		{ failure: "zero", existing: true },
		{ failure: "write", existing: true },
		{ failure: "cancel", existing: true },
		{ failure: "sync", existing: true },
		{ failure: "rename", existing: true },
	] as const)("$failure 失败清理临时文件并保留已发布 pack：$existing", async ({ failure, existing }) => {
		const journal = await fixture();
		const legacy = await readFile(legacyUrl);
		if (existing) await writeFile(durablePackPath(journal), legacy);
		const scope = createOperationScope();
		let temporary: FileHandle | undefined;
		let calls = 0;
		interceptTemporary((handle) => {
			temporary = handle;
			const original = handle.writev.bind(handle);
			handle.writev = async (buffers, position) => {
				if (calls++ > 0) {
					if (failure === "zero") return { bytesWritten: 0, buffers };
					if (failure === "write") throw new Error("注入写入失败");
				}
				const result = await original(prefixBuffers(buffers, 8), position);
				if (failure === "cancel") scope.cancel();
				return { bytesWritten: result.bytesWritten, buffers };
			};
			if (failure === "sync") handle.sync = async () => { throw new Error("注入同步失败"); };
		});
		if (failure === "rename") vi.mocked(rename).mockRejectedValue(new Error("注入发布失败"));
		const diagnostics = vi.fn();
		try {
			const creating = runWithOperationContext(scope.context, () => createDurablePack(journal, legacyInput(), { onDiagnostics: diagnostics }));
			if (failure === "cancel") {
				await expect(creating).rejects.toMatchObject({ code: "operation_cancelled" });
			} else {
				const message = { zero: "写入未推进", write: "注入写入失败", sync: "注入同步失败", rename: "注入发布失败" }[failure];
				await expect(creating).rejects.toThrow(message);
			}
			expect(temporary?.fd).toBe(-1);
			expect(diagnostics).not.toHaveBeenCalled();
			expect(await readdir(dirname(journal.storagePath))).toEqual(existing ? ["durable-pack-v1.bin"] : []);
			if (existing) expect(await readFile(durablePackPath(journal))).toEqual(legacy);
		} finally {
			scope.dispose();
		}
	});

	it("先同步并关闭临时文件再发布，最后同步父目录", async () => {
		const journal = await fixture();
		const events: string[] = [];
		vi.mocked(open).mockImplementation(async (...args) => {
			const handle = await actualFs.open(...args);
			const temporary = String(args[0]).endsWith(".tmp");
			const sync = handle.sync.bind(handle);
			const close = handle.close.bind(handle);
			handle.sync = async () => { events.push(temporary ? "file-sync" : "directory-sync"); await sync(); };
			handle.close = async () => { events.push(temporary ? "file-close" : "directory-close"); await close(); };
			return handle;
		});
		vi.mocked(rename).mockImplementation(async (...args) => { events.push("rename"); await actualFs.rename(...args); });
		await createDurablePack(journal, legacyInput());
		expect(events).toEqual(process.platform === "win32"
			? ["file-sync", "file-close", "rename"]
			: ["file-sync", "file-close", "rename", "directory-sync", "directory-close"]);
	});
});
