import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeDirectoryScanner } from "../src/native-directory-scan.ts";
import { createOperationScope, runWithOperationContext } from "../src/operation-context.ts";
import { RootDiscovery } from "../src/root-discovery.ts";
import { createGitRepo, createNestedRepo } from "./fixtures.ts";

const roots: string[] = [];
async function root(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-directory-scan-test-")));
	roots.push(path);
	return path;
}
async function helper(body: string): Promise<{ directory: string; path: string }> {
	const directory = await root();
	const path = join(directory, "helper.mjs");
	await writeFile(path, `#!${process.execPath}\n${body}`);
	await chmod(path, 0o755);
	return { directory, path };
}
const capabilities = `if (process.argv[2] === "--capabilities") console.log(JSON.stringify({ ok: true, capabilities: ["scan-directories-v1"] }));`;

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32" || process.env.PI_UNDO_DISABLE_NATIVE === "1")("NativeDirectoryScanner", () => {
	it("旧 helper 在私有目录探测且仅探测一次", async () => {
		const value = await helper(`
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(new URL("counter", import.meta.url), "x");
try { readFileSync(process.argv[2]); appendFileSync(new URL("mutated", import.meta.url), "x"); } catch {}
process.exit(2);
`);
		await writeFile(join(value.directory, "--capabilities"), "危险请求");
		const scanner = new NativeDirectoryScanner(value.path);
		await expect(scanner.scan(value.directory)).resolves.toBeUndefined();
		await expect(scanner.scan(value.directory)).resolves.toBeUndefined();
		expect(await readFile(join(value.directory, "counter"), "utf8")).toBe("x");
		await expect(lstat(join(value.directory, "mutated"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("原生与 TypeScript 对 ignored、嵌套仓库、损坏标记及 symlink 得到相同拓扑", async (context) => {
		const repository = await createGitRepo();
		roots.push(repository.root);
		const workspace = await realpath(repository.root);
		await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
		await createNestedRepo(workspace, "node_modules/pkg");
		await createNestedRepo(workspace, "node_modules/pkg/deep");
		await mkdir(join(workspace, "broken"));
		await writeFile(join(workspace, "broken/.git"), "invalid");
		await symlink(join(workspace, "node_modules"), join(workspace, "link"));
		const scanner = new NativeDirectoryScanner();
		const result = await scanner.scan(workspace);
		if (result === undefined) return context.skip();
		expect(result.repositories.map((entry) => entry.path).sort()).toEqual(["broken", "node_modules/pkg", "node_modules/pkg/deep"]);
		const fallback = new RootDiscovery(undefined, { scan: async () => undefined });
		await expect(new RootDiscovery(undefined, scanner).discover(workspace)).resolves.toEqual(await fallback.discover(workspace));
	});

	it("大小写不同的 Git 标记与当前文件系统的 TypeScript 语义一致", async (context) => {
		const workspace = await root();
		await createNestedRepo(workspace, "nested");
		await rename(join(workspace, "nested/.git"), join(workspace, "nested/.GIT"));
		const scanner = new NativeDirectoryScanner();
		if (await scanner.scan(workspace) === undefined) return context.skip();
		const fallback = new RootDiscovery(undefined, { scan: async () => undefined });
		await expect(new RootDiscovery(undefined, scanner).discover(workspace)).resolves.toEqual(await fallback.discover(workspace));
	});

	it("超过原生句柄深度时完整回退，仍能发现深层 Git 标记", async () => {
		const workspace = await root();
		const deep = Array.from({ length: 130 }, () => "d").join("/");
		await mkdir(join(workspace, deep), { recursive: true });
		await writeFile(join(workspace, deep, ".git"), "invalid");
		const scanner = new NativeDirectoryScanner();
		await expect(scanner.scan(workspace)).resolves.toBeUndefined();
		const topology = await new RootDiscovery(undefined, scanner).discover(workspace);
		expect(topology.roots.map((entry) => entry.relativeRoot)).toContain(deep);
	});

	it("扫描结果不跨检查点缓存", async (context) => {
		const workspace = await root();
		const scanner = new NativeDirectoryScanner();
		if (await scanner.scan(workspace) === undefined) return context.skip();
		await mkdir(join(workspace, "later/.git"), { recursive: true });
		expect((await scanner.scan(workspace))?.repositories.map((entry) => entry.path)).toEqual(["later"]);
	});

	it.for(["replaced", "removed"])("原生候选在 Git 识别前发生 %s 时结构化失败", async (change) => {
		const workspace = await root();
		await mkdir(join(workspace, "repo"));
		const metadata = await lstat(join(workspace, "repo"), { bigint: true });
		const discovery = new RootDiscovery(undefined, { scan: async () => {
			if (change === "removed") await rm(join(workspace, "repo"), { recursive: true });
			else {
				await rename(join(workspace, "repo"), join(workspace, "moved"));
				await symlink(join(workspace, "moved"), join(workspace, "repo"));
			}
			return { directories: 2, repositories: [{ path: "repo", dev: metadata.dev, ino: metadata.ino }] };
		} });
		await expect(discovery.discover(workspace)).rejects.toMatchObject({ name: "RootDiscoveryError", code: "discovery_failed" });
	});

	it.each([
		{ directories: 0, repositories: [] },
		{ directories: 2, repositories: [{ path: "../escape", dev: "1", ino: "2" }] },
		{ directories: 2, repositories: [{ path: "repo", dev: "18446744073709551616", ino: "2" }] },
		{ directories: 3, repositories: [{ path: "repo", dev: "1", ino: "2" }, { path: "repo", dev: "1", ino: "2" }] },
	])("拒绝不完整或不安全的扫描响应：%j", async (response) => {
		const value = await helper(`${capabilities} else console.log(${JSON.stringify(JSON.stringify({ ok: true, ...response }))});`);
		await expect(new NativeDirectoryScanner(value.path).scan(value.directory)).rejects.toThrow("native");
	});

	it("能力确认后的扫描失败向上传递", async () => {
		const value = await helper(`${capabilities} else { console.error("目录已替换"); process.exit(2); }`);
		await expect(new NativeDirectoryScanner(value.path).scan(value.directory)).rejects.toThrow("目录已替换");
	});

	it("首次能力探测取消后，下次操作仍可重新探测", async () => {
		const value = await helper(`
import { existsSync, writeFileSync } from "node:fs";
const marker = new URL("probe-started", import.meta.url);
if (process.argv[2] === "--capabilities") {
 if (!existsSync(marker)) { writeFileSync(marker, "x"); setTimeout(() => {}, 30000); }
 else console.log(JSON.stringify({ ok: true, capabilities: ["scan-directories-v1"] }));
} else console.log(JSON.stringify({ ok: true, directories: 1, repositories: [] }));
`);
		const scanner = new NativeDirectoryScanner(value.path);
		const scope = createOperationScope({ timeoutMs: 5_000 });
		const pending = runWithOperationContext(scope.context, () => scanner.scan(value.directory));
		const outcome = expect(pending).rejects.toMatchObject({ code: "operation_cancelled" });
		try {
			const deadline = Date.now() + 3_000;
			while (!await lstat(join(value.directory, "probe-started")).catch(() => undefined)) {
				if (Date.now() > deadline) throw new Error("能力探测未启动");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			scope.cancel();
			await outcome;
			await expect(scanner.scan(value.directory)).resolves.toEqual({ directories: 1, repositories: [] });
		} finally { scope.cancel(); scope.dispose(); }
	});

	it.for(["operation_cancelled", "operation_timeout"] as const)("%s 终止扫描进程并清理私有请求", async (code) => {
		const value = await helper(`
import { writeFileSync } from "node:fs";
${capabilities} else {
 writeFileSync(new URL("request-path", import.meta.url), process.argv[3]);
 setTimeout(() => {}, 30000);
}
`);
		const scope = createOperationScope(code === "operation_timeout" ? { timeoutMs: 200 } : {});
		const pending = runWithOperationContext(scope.context, () => new NativeDirectoryScanner(value.path).scan(value.directory));
		if (code === "operation_cancelled") setTimeout(() => scope.cancel(), 200);
		try {
			await expect(pending).rejects.toMatchObject({ code });
			const request = await readFile(join(value.directory, "request-path"), "utf8").catch(() => undefined);
			if (request !== undefined) await expect(lstat(request)).rejects.toMatchObject({ code: "ENOENT" });
		} finally { scope.dispose(); }
	});
});
