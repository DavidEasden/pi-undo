import { lstat, opendir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { DirectoryListingCache } from "./directory-listing-cache.ts";
import { allCompleted, checkOperation } from "./operation-context.ts";
import { relativeSafePath } from "./path-safety.ts";

const MAX_PARTITION_ENTRIES = 512;
const MAX_PARTITION_ARGUMENT_BYTES = 24 * 1024;
const PARALLEL_DIRECTORIES = 16;

async function directoryBinding(absolute: string): Promise<string> {
	const stat = await lstat(absolute, { bigint: true });
	if (!stat.isDirectory() || await realpath(absolute) !== absolute) throw new Error("忽略目录绑定发生变化");
	return `${absolute}\0${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** 只展开提示目录的祖先；每层从真实目录取齐所有同级项，不依赖提示的完整性。 */
export async function ignoredScanRoots(cwd: string, hints: ReadonlySet<string>): Promise<{
	names: string[]; directories: string[]; bindings: string[];
} | undefined> {
	const expand = new Set<string>();
	for (const path of hints) {
		relativeSafePath(cwd, path);
		if (path === "." || path.split("/").some((part) => part.toLowerCase() === ".git")) return undefined;
		for (let end = path.indexOf("/"); end >= 0; end = path.indexOf("/", end + 1)) {
			expand.add(path.slice(0, end));
			if (expand.size > MAX_PARTITION_ENTRIES) return undefined;
		}
	}
	const names: string[] = [];
	const directories: string[] = [];
	const bindings: string[] = [];
	const parents = ["."];
	let count = 0;
	let bytes = 0;
	for (const parent of parents) {
		checkOperation();
		const absolute = join(cwd, parent);
		bindings.push(await directoryBinding(absolute));
		for await (const entry of await opendir(absolute)) {
			if (parent === "." && entry.name === ".git") continue;
			if (entry.name.includes("\uFFFD") || entry.name.toLowerCase() === ".git") return undefined;
			const path = parent === "." ? entry.name : `${parent}/${entry.name}`;
			relativeSafePath(cwd, path);
			bytes += Buffer.byteLength(path) + 20;
			if (++count > MAX_PARTITION_ENTRIES || bytes > MAX_PARTITION_ARGUMENT_BYTES) return undefined;
			if (entry.isDirectory() && expand.has(path) && !hints.has(path)) {
				parents.push(path);
			} else {
				names.push(path);
				if (entry.isDirectory() && (parent === "." || hints.has(path))) {
					directories.push(path);
					bindings.push(await directoryBinding(join(cwd, path)));
				}
			}
		}
	}
	return { names: names.sort(), directories: directories.sort(), bindings: bindings.sort() };
}

/** 这里只枚举 Git 已确认整体忽略且无 index 条目的目录。忽略证明需要叶子名和类型，不需要文件内容。 */
export async function scanIgnoredDirectories(
	cwd: string,
	roots: readonly string[],
	listingCache?: DirectoryListingCache,
): Promise<string[]> {
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
				let entries: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
				if (listingCache !== undefined) {
					// 缓存层负责 lstat 与 dev/ino/mtime/ctime 复核；枚举期间变化（stable=false）同样拒绝。
					const listing = await listingCache.list(absolute);
					if (listing === undefined || !listing.stable || await realpath(absolute) !== absolute) {
						throw new Error("忽略目录枚举期间发生变化");
					}
					entries = listing.entries;
				} else {
					const before = await lstat(absolute, { bigint: true });
					if (!before.isDirectory() || await realpath(absolute) !== absolute) throw new Error("忽略目录绑定发生变化");
					const dirents = await readdir(absolute, { withFileTypes: true });
					const after = await lstat(absolute, { bigint: true });
					if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
						before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs ||
						await realpath(absolute) !== absolute) throw new Error("忽略目录枚举期间发生变化");
					entries = dirents.map((entry) => ({
						name: entry.name,
						kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
					}));
				}
				for (const entry of entries) {
					if (entry.name.toLowerCase() === ".git" || entry.name.includes("\uFFFD")) throw new Error("忽略目录需要 Git 精确枚举");
					const path = `${directory}/${entry.name}`;
					pathBytes += Buffer.byteLength(path);
					if (++entriesSeen > 262_144 || pathBytes > 32 * 1024 * 1024) throw new Error("忽略目录枚举超过预算");
					relativeSafePath(cwd, path);
					if (entry.kind === "directory") next.push(path);
					else if (entry.kind === "file" || entry.kind === "symlink") leaves.push(path);
					else throw new Error("特殊目录项需要 Git 精确枚举");
				}
			}));
		}
		level = next;
	}
	return leaves;
}
