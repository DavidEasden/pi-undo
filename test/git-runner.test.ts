import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { GitRunner } from "../src/git-runner.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeGit(script: string): Promise<{ root: string; env: Record<string, string> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-git-"));
	temporaryRoots.push(root);
	const bin = join(root, "bin");
	await mkdir(bin);
	const executable = join(bin, "git");
	await writeFile(executable, `#!/bin/sh\n${script}\n`);
	await chmod(executable, 0o755);
	return { root, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } };
}

describe("GitRunner", () => {
	it("执行成功命令并保留 stdout/stderr", async () => {
		const runner = new GitRunner();
		const result = await runner.run(["--version"]);

		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.stdout).toContain("git version");
	});

	it("非零退出抛出稳定 git_failed 错误", async () => {
		const runner = new GitRunner();

		await expect(runner.run(["--definitely-invalid"])).rejects.toMatchObject({ code: "git_failed" });
	});

	it("不经过 shell 拼接参数，并截断过长 stderr", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "pi-undo-marker-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "created");
		const fake = await fakeGit(
			`printf '%s' "$1" > "$MARKER"\nprintf '%0100000d' 0 >&2`,
		);
		const runner = new GitRunner();
		const result = await runner.run([`$(touch ${marker})`], {
			env: { ...fake.env, MARKER: marker },
		});

		expect(result.code).toBe(0);
		expect(result.stderr.length).toBeLessThan(100_000);
		expect(await readFile(marker, "utf8")).toBe("$(touch " + marker + ")");
	});

	it("超时终止进程并返回 killed", async () => {
		const fake = await fakeGit("exec sleep 5");
		const result = await new GitRunner().run([], { env: fake.env, timeoutMs: 20 });

		expect(result.killed).toBe(true);
		expect(result.timedOut).toBe(true);
	});

	it("超时会终止 Git 进程组，避免后台子进程继续写入", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "pi-undo-marker-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "created");
		const fake = await fakeGit(`(sleep 0.2; touch "$MARKER") >/dev/null 2>&1 &\nsleep 5`);

		const result = await new GitRunner().run([], {
			env: { ...fake.env, MARKER: marker },
			timeoutMs: 20,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(result.killed).toBe(true);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("AbortSignal 终止进程并返回 killed", async () => {
		const fake = await fakeGit("exec sleep 5");
		const controller = new AbortController();
		const pending = new GitRunner().run([], { env: fake.env, signal: controller.signal });
		setTimeout(() => controller.abort(), 20);

		const result = await pending;
		expect(result.killed).toBe(true);
		expect(result.aborted).toBe(true);
	});

	it("外部信号终止也会在错误结果中标记 killed", async () => {
		const fake = await fakeGit("kill -TERM $$");

		await expect(new GitRunner().run([], { env: fake.env })).rejects.toMatchObject({
			code: "git_failed",
			result: { code: null, killed: true },
		});
	});
});
