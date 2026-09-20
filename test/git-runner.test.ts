import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GIT_TIMEOUT_MS, GitRunner, runSupervisedProcess } from "../src/git-runner.ts";
import { createOperationScope, runWithOperationContext, type ProcessDiagnostic } from "../src/operation-context.ts";

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

async function scriptExecutable(name: string, source: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-supervised-"));
	temporaryRoots.push(root);
	const path = join(root, name);
	await writeFile(path, `#!/bin/sh\n${source}\n`);
	await chmod(path, 0o755);
	return path;
}

async function markerPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-undo-marker-"));
	temporaryRoots.push(root);
	return join(root, "created");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("GitRunner", () => {
	it("诊断只记录子命令、耗时和退出结果，不记录敏感参数与输出", async () => {
		const fake = await fakeGit("printf '私密输出'; printf '私密错误' >&2");
		const records: ProcessDiagnostic[] = [];
		const scope = createOperationScope({ onProcess: (record) => records.push(record) });
		try {
			await runWithOperationContext(scope.context, () => new GitRunner().run(["cat-file", "blob", "私密参数"], { env: fake.env }));
			expect(records).toEqual([{ command: "git:cat-file", durationMs: expect.any(Number), outcome: "exit", exitCode: 0 }]);
			expect(JSON.stringify(records)).not.toContain("私密");
		} finally {
			scope.dispose();
		}
	});
	it("执行成功命令并保留 stdout/stderr", async () => {
		const runner = new GitRunner();
		const result = await runner.run(["--version"]);

		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.stdout).toContain("git version");
	});

	it("同时保留 stdout 原始字节，避免二进制 blob 被 UTF-8 转码损坏", async () => {
		const fake = await fakeGit("printf '\\000\\377'");

		const result = await new GitRunner().run([], { env: fake.env });

		expect(result.stdoutBytes).toEqual(new Uint8Array([0, 255]));
	});

	it("以原始字节写入 Git stdin", async () => {
		const fake = await fakeGit("cat");

		const result = await new GitRunner().run([], {
			env: fake.env,
			stdin: new Uint8Array([0, 1, 255]),
		});

		expect(result.stdoutBytes).toEqual(new Uint8Array([0, 1, 255]));
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

	it("Git 被外部信号终止后也确认后代退出，不留下迟到写入", async () => {
		const marker = await markerPath();
		const fake = await fakeGit('(sleep 0.2; touch "$MARKER") >/dev/null 2>&1 &\nkill -TERM $$');
		await expect(new GitRunner().run([], { env: { ...fake.env, MARKER: marker } }))
			.rejects.toMatchObject({ code: "git_failed", result: { killed: true } });
		await delay(300);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("默认预算为 120 秒", () => {
		expect(DEFAULT_GIT_TIMEOUT_MS).toBe(120_000);
	});

	it("context deadline 用剩余预算终止挂起的 Git", async () => {
		const fake = await fakeGit("exec sleep 5");
		const scope = createOperationScope({ timeoutMs: 30 });
		try {
			const result = await runWithOperationContext(scope.context, () => new GitRunner().run([], { env: fake.env }));

			expect(result.killed).toBe(true);
			expect(result.timedOut).toBe(true);
		} finally {
			scope.dispose();
		}
	});

	it("context deadline 收紧显式传入的更长预算", async () => {
		const marker = await markerPath();
		const fake = await fakeGit(`(sleep 0.2; touch "$MARKER") >/dev/null 2>&1 &\nsleep 5`);
		const scope = createOperationScope({ timeoutMs: 30 });
		try {
			const result = await runWithOperationContext(
				scope.context,
				() => new GitRunner().run([], { env: { ...fake.env, MARKER: marker }, timeoutMs: 120_000 }),
			);
			await delay(300);

			expect(result.killed).toBe(true);
			expect(result.timedOut).toBe(true);
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			scope.dispose();
		}
	});

	it("调用方 signal 与 context signal 合并，任一取消都终止进程", async () => {
		const fake = await fakeGit("exec sleep 5");
		const controller = new AbortController();
		const scope = createOperationScope({ timeoutMs: 60_000 });
		try {
			const pending = runWithOperationContext(
				scope.context,
				() => new GitRunner().run([], { env: fake.env, signal: controller.signal }),
			);
			setTimeout(() => controller.abort(), 20);

			const result = await pending;
			expect(result.killed).toBe(true);
			expect(result.aborted).toBe(true);
		} finally {
			scope.dispose();
		}
	});

	it("context 取消真实终止进程组，不留下迟到写入", async () => {
		const marker = await markerPath();
		const fake = await fakeGit(`(sleep 0.2; touch "$MARKER") >/dev/null 2>&1 &\nsleep 5`);
		const scope = createOperationScope();
		try {
			const pending = runWithOperationContext(
				scope.context,
				() => new GitRunner().run([], { env: { ...fake.env, MARKER: marker } }),
			);
			setTimeout(() => scope.cancel(), 20);

			const result = await pending;
			await delay(300);

			expect(result.killed).toBe(true);
			expect(result.aborted).toBe(true);
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			scope.dispose();
		}
	});

	it("已取消的 context 在 spawn 之前结束", async () => {
		const marker = await markerPath();
		const fake = await fakeGit(`touch "$MARKER"`);
		const scope = createOperationScope();
			scope.cancel();
		try {
			const result = await runWithOperationContext(
				scope.context,
				() => new GitRunner().run([], { env: { ...fake.env, MARKER: marker } }),
			);

			expect(result).toMatchObject({ killed: true, aborted: true });
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			scope.dispose();
		}
	});

	it("已超时的 context 不启动 Git 调用", async () => {
		const marker = await markerPath();
		const fake = await fakeGit(`touch "$MARKER"`);

		const result = await runWithOperationContext(
			{ signal: new AbortController().signal, deadline: Date.now() - 1 },
			() => new GitRunner().run([], { env: { ...fake.env, MARKER: marker } }),
		);

		expect(result).toMatchObject({ killed: true, timedOut: true });
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("确认进程组退出后，即便 close 一直不到达也会结束", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-undo-escaped-"));
		temporaryRoots.push(root);
		const release = join(root, "release");
		const helper = join(root, "helper.mjs");
		// 直接子进程退出后，逃逸到独立进程组的孙进程仍持有 stdout 管道，close 永远不会到达。
		await writeFile(helper, `
import { spawn } from "node:child_process";
const child = spawn("sh", ["-c", \`while [ ! -f "\${process.env.RELEASE}" ]; do sleep 0.05; done\`], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
child.unref();
`);
		const fake = await fakeGit(`node "$HELPER"\nexit 0`);
		const pending = new GitRunner().run([], {
			env: { ...fake.env, HELPER: helper, RELEASE: release },
			timeoutMs: 50,
		});
		try {
			const result = await Promise.race([
				pending,
				delay(3_000).then(() => {
					throw new Error("GitRunner 在确认进程组退出前没有结束");
				}),
			]);

			expect(result.killed).toBe(true);
			expect(result.timedOut).toBe(true);
		} finally {
			await writeFile(release, "");
		}
	});
});

describe("runSupervisedProcess", () => {
	it("超时终止进程组并确认退出", async () => {
		const marker = await markerPath();
		const executable = await scriptExecutable(
			"helper",
			`(sleep 0.2; touch "$MARKER") >/dev/null 2>&1 &\nsleep 5`,
		);

		const result = await runSupervisedProcess({
			command: executable,
			args: [],
			env: { MARKER: marker },
			timeoutMs: 30,
			outputLimitBytes: 1_024,
		});
		await delay(300);

		expect(result.outcome).toBe("timeout");
		expect(result.stopped).toBe(true);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("signal 取消返回 cancelled 并确认进程组退出", async () => {
		const executable = await scriptExecutable("helper", "exec sleep 5");
		const controller = new AbortController();
		const pending = runSupervisedProcess({
			command: executable,
			args: [],
			signal: controller.signal,
			timeoutMs: 5_000,
			outputLimitBytes: 1_024,
		});
		setTimeout(() => controller.abort(), 20);

		const result = await pending;

		expect(result.outcome).toBe("cancelled");
		expect(result.stopped).toBe(true);
	});

	it("已取消的 signal 不启动进程", async () => {
		const marker = await markerPath();
		const executable = await scriptExecutable("helper", `touch "$MARKER"`);
		const controller = new AbortController();
		controller.abort();

		const result = await runSupervisedProcess({
			command: executable,
			args: [],
			env: { MARKER: marker },
			signal: controller.signal,
			timeoutMs: 5_000,
			outputLimitBytes: 1_024,
		});

		expect(result).toMatchObject({ outcome: "cancelled", stopped: true });
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("输出超过限制时终止进程组并保留已捕获输出", async () => {
		const executable = await scriptExecutable("helper", `printf '%0100000d' 0`);

		const result = await runSupervisedProcess({
			command: executable,
			args: [],
			timeoutMs: 5_000,
			outputLimitBytes: 100,
			outputOverflow: "terminate",
		});

		expect(result.outcome).toBe("output_overflow");
		expect(result.stopped).toBe(true);
		expect(result.stdout.length).toBe(100);
	});

	it("outputOverflow=truncate 只停止捕获，不终止进程", async () => {
		const executable = await scriptExecutable("helper", "printf 'abcdefghij'");

		const result = await runSupervisedProcess({
			command: executable,
			args: [],
			timeoutMs: 5_000,
			outputLimitBytes: 4,
		});

		expect(result.outcome).toBe("exit");
		expect(result.code).toBe(0);
		expect(result.stdout.toString("utf8")).toBe("abcd");
	});
});
