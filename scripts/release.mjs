#!/usr/bin/env node
/**
 * 发布脚本：本地校验 → 版本递增 → 推送 → 等待 CI（失败自动重跑）→ 校验 npm。
 *
 * 用法：
 *   npm run release -- patch|minor|major|<x.y.z> [--skip-tests] [--dry-run]
 *
 * 设计原则：
 * - 不自动提交任何改动：工作区必须干净，避免把半成品发出去。
 * - 不 force push：推送失败只重试，不改写远端历史。
 * - CI 失败最多 rerun --failed 两次：macOS runner 卡死与 npm Rekor 409 均为瞬时故障。
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CI_RERUNS = 2;
const MAX_PUSH_ATTEMPTS = 8;
const PACKAGE_NAME = "@davideasden/pi-undo";

class ReleaseError extends Error {}

function log(message) {
	console.log(`[release] ${message}`);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** 只取首行，避免把整段 git 输出塞进错误信息。 */
function firstLine(text) {
	return (text ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
}

/** 执行命令并返回成败与输出；不抛异常，便于按需重试。 */
async function tryExec(command, args, options = {}) {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			maxBuffer: 32 * 1024 * 1024,
			...options,
		});
		return { ok: true, stdout: stdout.toString().trim(), stderr: stderr.toString().trim() };
	} catch (error) {
		return {
			ok: false,
			stdout: (error.stdout ?? "").toString().trim(),
			stderr: (error.stderr ?? "").toString().trim(),
			message: error.message,
		};
	}
}

async function must(command, args, label, options = {}) {
	const result = await tryExec(command, args, options);
	if (!result.ok) {
		throw new ReleaseError(`${label} 失败：${firstLine(result.stderr || result.stdout || result.message)}`);
	}
	return result.stdout;
}

/** 拉取远端 main；网络抖动时重试，与推送保持一致。 */
async function fetchWithRetry(attempts = MAX_PUSH_ATTEMPTS) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = await tryExec("git", ["-c", "http.connectTimeout=20", "fetch", "origin", "main"], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		if (result.ok) return;
		log(`  拉取远端失败（${attempt}/${attempts}）：${firstLine(result.stderr || result.message)}`);
		await sleep(3000);
	}
	throw new ReleaseError(`拉取远端 main 失败（已尝试 ${attempts} 次）`);
}

/** 前置检查：仓库根、分支、工作区、gh 认证、不落后远端。 */
async function preflight() {
	log("→ 前置检查");
	const root = await must("git", ["rev-parse", "--show-toplevel"], "读取仓库根");
	if (root !== process.cwd()) {
		log(`  切换到仓库根：${root}`);
		process.chdir(root);
	}

	const branch = await must("git", ["rev-parse", "--abbrev-ref", "HEAD"], "读取当前分支");
	if (branch !== "main") {
		throw new ReleaseError(`当前分支是 ${branch}，发布必须在 main 上进行`);
	}

	const status = await must("git", ["status", "--porcelain"], "读取工作区状态");
	if (status !== "") {
		throw new ReleaseError(`工作区有未提交改动，请先提交或暂存：\n${status}`);
	}

	const auth = await tryExec("gh", ["auth", "status"]);
	if (!auth.ok) {
		throw new ReleaseError(`gh 认证不可用：${firstLine(auth.stderr || auth.stdout)}`);
	}

	await fetchWithRetry();
	const behind = Number(await must("git", ["rev-list", "--count", "HEAD..origin/main"], "比较远端 main"));
	if (behind > 0) {
		throw new ReleaseError(`本地 main 落后远端 ${behind} 个提交，请先同步`);
	}
	log("  通过");
}

/** 本地校验：类型检查 + Rust 测试 + 完整测试（可选跳过）。 */
async function localChecks(skipTests) {
	log("→ 本地校验（typecheck / cargo test / npm test）");
	await must("npm", ["run", "typecheck"], "typecheck");
	await must("cargo", ["test", "--manifest-path", "native/pi-undo-fs/Cargo.toml"], "cargo test");
	if (skipTests) {
		log("  已跳过 npm test（--skip-tests）");
		return;
	}
	await must("npm", ["test"], "npm test", {
		env: { ...process.env, PI_UNDO_RUN_RESIDENT_LIVE: "1" },
	});
	log("  通过");
}

/** 计算目标版本，并确认 npm 与本地 tag 都还没被占用。 */
async function resolveVersion(spec) {
	const current = JSON.parse(await readFile("package.json", "utf8")).version;
	let next;
	if (/^\d+\.\d+\.\d+$/.test(spec)) {
		next = spec;
	} else {
		const [major, minor, patch] = current.split(".").map(Number);
		if (spec === "patch") next = `${major}.${minor}.${patch + 1}`;
		else if (spec === "minor") next = `${major}.${minor + 1}.0`;
		else if (spec === "major") next = `${major + 1}.0.0`;
		else throw new ReleaseError(`无法识别的版本参数：${spec}（可用 patch/minor/major/x.y.z）`);
	}
	if (next === current) {
		throw new ReleaseError(`目标版本与当前版本相同：${next}`);
	}

	const npmExisting = await tryExec("npm", ["view", `${PACKAGE_NAME}@${next}`, "version"]);
	if (npmExisting.ok && npmExisting.stdout !== "") {
		throw new ReleaseError(`npm 上已存在 ${PACKAGE_NAME}@${next}，不能复用版本号`);
	}
	const tagExisting = await tryExec("git", ["rev-parse", "--verify", `v${next}`]);
	if (tagExisting.ok) {
		throw new ReleaseError(`本地 tag v${next} 已存在`);
	}
	return { current, next };
}

/** 推送单个 ref，遇到网络错误重试（不 force）。 */
async function pushWithRetry(ref) {
	for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
		const result = await tryExec("git", ["-c", "http.connectTimeout=20", "push", "origin", ref], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		if (result.ok) {
			log(`  已推送 ${ref}`);
			return;
		}
		log(`  推送 ${ref} 失败（${attempt}/${MAX_PUSH_ATTEMPTS}）：${firstLine(result.stderr || result.message)}`);
		await sleep(3000);
	}
	throw new ReleaseError(`推送 ${ref} 失败（已尝试 ${MAX_PUSH_ATTEMPTS} 次）`);
}

/** 等待 tag 触发的 workflow run 出现，返回其 id。 */
async function waitForRun(tag) {
	log(`→ 等待 tag ${tag} 触发 CI`);
	for (let attempt = 1; attempt <= 60; attempt += 1) {
		const output = await must(
			"gh",
			["run", "list", "--limit", "10", "--json", "databaseId,headBranch,event"],
			"查询 CI runs",
		);
		const runs = JSON.parse(output);
		const matched = runs.find((run) => run.headBranch === tag && run.event === "push");
		if (matched !== undefined) {
			log(`  run ${matched.databaseId}`);
			return matched.databaseId;
		}
		await sleep(5000);
	}
	throw new ReleaseError(`未找到 tag ${tag} 触发的 CI run`);
}

/** 轮询 run 直到结束；失败时自动 rerun 失败的 job，最多 MAX_CI_RERUNS 次。 */
async function waitForRunCompletion(runId) {
	let reruns = 0;
	for (;;) {
		const output = await must(
			"gh",
			["run", "view", String(runId), "--json", "status,conclusion,jobs"],
			"查询 CI 状态",
		);
		const data = JSON.parse(output);
		if (data.status !== "completed") {
			await sleep(20000);
			continue;
		}
		if (data.conclusion === "success") {
			log("  CI 成功");
			return;
		}
		for (const job of data.jobs ?? []) {
			if (job.conclusion !== "success" && job.conclusion !== "skipped") {
				log(`  ✗ ${job.name}: ${job.conclusion}`);
			}
		}
		if (reruns >= MAX_CI_RERUNS) {
			throw new ReleaseError(`CI 失败（${data.conclusion}），已重跑 ${reruns} 次仍未成功`);
		}
		reruns += 1;
		log(`  CI 失败（${data.conclusion}），重跑失败 job（第 ${reruns}/${MAX_CI_RERUNS} 次）`);
		await must("gh", ["run", "rerun", String(runId), "--failed"], "重跑 CI");
		await sleep(15000);
	}
}

/** npm 上传有数分钟延迟，轮询 tarball 直到可用。 */
async function waitForNpm(version) {
	log(`→ 等待 npm tarball（${PACKAGE_NAME}@${version}）`);
	// registry 的 tarball 路径用包名 basename：@scope/pi-undo → .../-/pi-undo-<version>.tgz
	const tarballName = `${PACKAGE_NAME.split("/").pop()}-${version}.tgz`;
	const url = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${tarballName}`;
	for (let attempt = 1; attempt <= 40; attempt += 1) {
		let status = 0;
		try {
			const response = await fetch(url, { method: "HEAD" });
			status = response.status;
		} catch {
			status = 0;
		}
		if (status === 200) {
			log(`  tarball 可用（第 ${attempt} 次）`);
			return url;
		}
		if (attempt % 5 === 0) {
			log(`  仍不可用（第 ${attempt} 次，HTTP ${status || "网络错误"}）`);
		}
		await sleep(15000);
	}
	throw new ReleaseError(`npm tarball 始终不可用：${url}`);
}

async function main() {
	const args = process.argv.slice(2);
	const spec = args.find((argument) => !argument.startsWith("--"));
	const skipTests = args.includes("--skip-tests");
	const dryRun = args.includes("--dry-run");
	if (spec === undefined) {
		console.error("用法：npm run release -- patch|minor|major|<x.y.z> [--skip-tests] [--dry-run]");
		process.exitCode = 1;
		return;
	}

	await preflight();
	const { current, next } = await resolveVersion(spec);
	log(`→ 版本：${current} → ${next}`);
	if (dryRun) {
		log("dry-run：仅校验，不做任何改动");
		return;
	}

	await localChecks(skipTests);

	log("→ 递增版本并提交");
	await must("npm", ["version", next, "-m", `chore: release v${next}`], "npm version");

	log("→ 推送 main 与 tag");
	// 先确认 main 推成功再推 tag，避免 tag 指向远端不存在的提交。
	await pushWithRetry("main");
	await pushWithRetry(`v${next}`);

	const runId = await waitForRun(`v${next}`);
	await waitForRunCompletion(runId);
	const tarball = await waitForNpm(next);

	log(`✅ 已发布 ${PACKAGE_NAME}@${next}`);
	log(`   https://github.com/DavidEasden/pi-undo/releases/tag/v${next}`);
	log(`   ${tarball}`);
}

main().catch((error) => {
	if (error instanceof ReleaseError) {
		console.error(`[release] ❌ ${error.message}`);
	} else {
		console.error(`[release] ❌ 未预期错误：${error?.stack ?? error}`);
	}
	process.exitCode = 1;
});
