import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeMetadataInspector } from "../src/native-metadata.ts";

const roots: string[] = [];

async function executable(source: string): Promise<{ root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-native-metadata-"));
	roots.push(root);
	const path = join(root, "helper.mjs");
	await writeFile(path, `#!${process.execPath}\n${source}`);
	await chmod(path, 0o755);
	return { root, path };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NativeMetadataInspector", () => {
	it("严格解析 bigint metadata 并清理 request", async () => {
		if (process.platform === "win32") return;
		const helper = await executable(`
import { readFileSync } from "node:fs";
const [, , action, requestPath] = process.argv;
if (action === "--capabilities") {
  console.log(JSON.stringify({ ok: true, capabilities: ["inspect-v1"] }));
} else {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  console.log(JSON.stringify({ ok: true, processed: request.paths.length, entries: request.paths.map((path, index) => index === 0 ? {
    path, kind: "file", dev: "1", ino: "2", mode: "33188", size: "3", mtimeNs: "4", ctimeNs: "5"
  } : { path, kind: "absent", dev: null, ino: null, mode: null, size: null, mtimeNs: null, ctimeNs: null }) }));
}
`);
		const inspector = new NativeMetadataInspector(helper.path);
		await expect(inspector.inspect(helper.root, ["a.txt", "gone.txt"], helper.root)).resolves.toEqual([
			{ path: "a.txt", kind: "file", dev: 1n, ino: 2n, mode: 33188n, size: 3n, mtimeNs: 4n, ctimeNs: 5n },
			{ path: "gone.txt", kind: "absent" },
		]);
		expect((await readdir(helper.root)).sort()).toEqual(["helper.mjs"]);
	});

	it("旧 positional helper 的能力探测在私有空目录运行", async () => {
		if (process.platform === "win32") return;
		const helper = await executable(`
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(new URL("observed-cwd", import.meta.url), process.cwd());
try {
  JSON.parse(readFileSync(process.argv[2], "utf8"));
  appendFileSync(new URL("mutated", import.meta.url), "x");
} catch {}
process.exit(2);
`);
		const isolated = join(helper.root, "isolated");
		await mkdir(isolated);
		await writeFile(join(helper.root, "--capabilities"), JSON.stringify({ dangerous: true }));
		const inspector = new NativeMetadataInspector(helper.path);
		await expect(inspector.inspect(helper.root, ["a.txt"], isolated)).resolves.toBeUndefined();
		expect(await readFile(join(helper.root, "observed-cwd"), "utf8")).toBe(await realpath(isolated));
		await expect(readFile(join(helper.root, "mutated"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("旧 helper 缺少能力时熔断并回退", async () => {
		if (process.platform === "win32") return;
		const helper = await executable(`
import { appendFileSync } from "node:fs";
appendFileSync(new URL("counter", import.meta.url), "x");
process.exit(2);
`);
		const inspector = new NativeMetadataInspector(helper.path);
		await expect(inspector.inspect(helper.root, ["a.txt"], helper.root)).resolves.toBeUndefined();
		await expect(inspector.inspect(helper.root, ["a.txt"], helper.root)).resolves.toBeUndefined();
		expect(await readFile(join(helper.root, "counter"), "utf8")).toBe("x");
	});

	it("拒绝超出平台 wire 范围的数字字段", async () => {
		if (process.platform === "win32") return;
		const helper = await executable(`
import { readFileSync } from "node:fs";
const action = process.argv[2];
if (action === "--capabilities") console.log(JSON.stringify({ ok: true, capabilities: ["inspect-v1"] }));
else {
  const request = JSON.parse(readFileSync(process.argv[3], "utf8"));
  console.log(JSON.stringify({ ok: true, processed: 1, entries: [{ path: request.paths[0], kind: "file",
    dev: "18446744073709551616", ino: "1", mode: "1", size: "1", mtimeNs: "1", ctimeNs: "1" }] }));
}
`);
		const inspector = new NativeMetadataInspector(helper.path);
		await expect(inspector.inspect(helper.root, ["a.txt"], helper.root))
			.rejects.toThrow("native metadata unsigned 字段");
	});

	it("能力确认后的 inspect 错误保持 fail-closed", async () => {
		if (process.platform === "win32") return;
		const helper = await executable(`
const action = process.argv[2];
if (action === "--capabilities") console.log(JSON.stringify({ ok: true, capabilities: ["inspect-v1"] }));
else { console.error("unsafe parent"); process.exit(2); }
`);
		const inspector = new NativeMetadataInspector(helper.path);
		await expect(inspector.inspect(helper.root, ["a.txt"], helper.root))
			.rejects.toThrow("native metadata inspect 失败：unsafe parent");
	});
});
