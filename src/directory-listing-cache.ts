import { lstat, readdir } from "node:fs/promises";

/** 目录项类型；other 表示设备、FIFO 等特殊项，由调用方决定如何处理。 */
export type ListedEntryKind = "directory" | "file" | "symlink" | "other";

export interface ListedEntry {
	readonly name: string;
	readonly kind: ListedEntryKind;
}

export interface DirectoryListing {
	readonly entries: readonly ListedEntry[];
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	/** 枚举前后 mtime/ctime 一致；false 时 entries 仍是本次读取结果，但不进入缓存。 */
	readonly stable: boolean;
	/** 目录最后修改早于枚举时刻超过 racy 窗口；只有 settled 的列表可作为类型证据复用。 */
	readonly settled: boolean;
}

interface CachedListing extends DirectoryListing {
	readonly listedAtNs: bigint;
}

/**
 * 部分共享盘只提供秒级时间戳：枚举与目录变化落在同一窗口内时，后续变化可能不改变 mtime/ctime。
 * 只有目录最后变化早于枚举时刻超过该窗口，缓存才可复用（与 Git racy-clean 判断同理）。
 */
const RACY_WINDOW_NS = 2_000_000_000n;
const MAX_CACHED_DIRECTORIES = 200_000;

/**
 * 复用同一进程内已读取的目录项列表。每次读取都重新 lstat；dev/ino/mtime/ctime 任一变化，
 * 或缓存时目录仍处于 racy 窗口，就重新 readdir。调用方的前后身份与边界复核保持不变。
 */
export class DirectoryListingCache {
	private readonly listings = new Map<string, CachedListing>();

	/** 目录不存在、不是目录或是 symlink 时返回 undefined。 */
	async list(path: string): Promise<DirectoryListing | undefined> {
		const before = await lstat(path, { bigint: true }).catch(() => undefined);
		if (before === undefined || before.isSymbolicLink() || !before.isDirectory()) {
			this.listings.delete(path);
			return undefined;
		}
		const cached = this.listings.get(path);
		if (
			cached !== undefined && cached.dev === before.dev && cached.ino === before.ino &&
			cached.mtimeNs === before.mtimeNs && cached.ctimeNs === before.ctimeNs &&
			// 目录项增删必然更新 mtime；ctime 还会被 chmod/utimes 刷新，只用于相等比较，不参与窗口判断。
			cached.listedAtNs - RACY_WINDOW_NS > cached.mtimeNs
		) {
			return cached;
		}
		const listedAtNs = BigInt(Date.now()) * 1_000_000n;
		const dirents = await readdir(path, { withFileTypes: true });
		const after = await lstat(path, { bigint: true }).catch(() => undefined);
		this.listings.delete(path);
		if (
			after === undefined || after.isSymbolicLink() || !after.isDirectory() ||
			after.dev !== before.dev || after.ino !== before.ino
		) {
			// 目录身份变化：调用方按原逻辑跳过该目录。
			return undefined;
		}
		const stable = after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
		const listing: CachedListing = {
			entries: dirents.map((entry) => ({
				name: entry.name,
				kind: entry.isSymbolicLink() ? "symlink"
					: entry.isDirectory() ? "directory"
					: entry.isFile() ? "file" : "other",
			})),
			dev: after.dev,
			ino: after.ino,
			mtimeNs: after.mtimeNs,
			ctimeNs: after.ctimeNs,
			stable,
			settled: listedAtNs - RACY_WINDOW_NS > after.mtimeNs,
			listedAtNs,
		};
		// 枚举期间内容变化的结果只交给本次调用，不缓存。
		if (!stable) return listing;
		if (this.listings.size >= MAX_CACHED_DIRECTORIES && !this.listings.has(path)) this.listings.clear();
		this.listings.set(path, listing);
		return listing;
	}

	clear(): void {
		this.listings.clear();
	}
}
