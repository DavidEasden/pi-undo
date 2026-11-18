import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { allCompleted, checkOperation } from "./operation-context.ts";
import { relativeSafePath } from "./path-safety.ts";

const MAX_ROOT_ENTRIES = 512;
const MAX_ROOT_ARGUMENT_BYTES = 24 * 1024;
const PARALLEL_DIRECTORIES = 16;

/** 只分割根目录一层，剩余项仍交给原 Git 查询；不能无损表示或参数过长时不分割。 */
export async function ignoredScanRoots(cwd: string): Promise<{ names: string[]; directories: string[] } | undefined> {
	const entries = await readdir(cwd, { withFileTypes: true });
	if (entries.length > MAX_ROOT_ENTRIES) return undefined;
	const names: string[] = [];
	const directories: string[] = [];
	let bytes = 0;
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (entry.name.includes("\uFFFD") || entry.name.toLowerCase() === ".git") return undefined;
		relativeSafePath(cwd, entry.name);
		bytes += Buffer.byteLength(entry.name) + 20;
		if (bytes > MAX_ROOT_ARGUMENT_BYTES) return undefined;
		names.push(entry.name);
		if (entry.isDirectory()) directories.push(entry.name);
	}
	return { names: names.sort(), directories: directories.sort() };
}

/** 这里只枚举 Git 已确认整体忽略且无 index 条目的目录。忽略证明需要叶子名和类型，不需要文件内容。 */
export async function scanIgnoredDirectories(cwd: string, roots: readonly string[]): Promise<string[]> {
	let level = [...roots];
	const leaves: string[] = [];
	let entriesSeen = 0;
	let pathBytes = 0;
	while (level.length > 0) {
		const next: string[] = [];
		for (let start = 0; start < level.length; start += PARALLEL_DIRECTORIES) {
			checkOperation();
			await allCompleted(level.slice(start, start + PARALLEL_DIRECTORIES).map(async (directory) => {
				const absolute = join(cwd, directory);
				const before = await lstat(absolute, { bigint: true });
				if (!before.isDirectory() || await realpath(absolute) !== absolute) throw new Error("忽略目录绑定发生变化");
				const entries = await readdir(absolute, { withFileTypes: true });
				const after = await lstat(absolute, { bigint: true });
				if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
					before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs ||
					await realpath(absolute) !== absolute) throw new Error("忽略目录枚举期间发生变化");
				for (const entry of entries) {
					if (entry.name.toLowerCase() === ".git" || entry.name.includes("\uFFFD")) throw new Error("忽略目录需要 Git 精确枚举");
					const path = `${directory}/${entry.name}`;
					pathBytes += Buffer.byteLength(path);
					if (++entriesSeen > 262_144 || pathBytes > 32 * 1024 * 1024) throw new Error("忽略目录枚举超过预算");
					relativeSafePath(cwd, path);
					if (entry.isDirectory()) next.push(path);
					else if (entry.isFile() || entry.isSymbolicLink()) leaves.push(path);
					else throw new Error("特殊目录项需要 Git 精确枚举");
				}
			}));
		}
		level = next;
	}
	return leaves;
}
