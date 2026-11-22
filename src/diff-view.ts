import { isUtf8 } from "node:buffer";

import { compareDiffText } from "./diff-text.ts";
import type { ManifestId, RestorePath, SnapshotManifest } from "./model.ts";
import { SnapshotStore, type SnapshotBlobRequest } from "./snapshot-store.ts";

/** /diff 只从快照读取，不接触工作区文件。 */
export type DiffSource = Pick<SnapshotStore, "loadManifest" | "listTree" | "readBlob">;

export type FileDiffStatus = "added" | "deleted" | "modified";
export type FileDiffKind = "text" | "binary" | "symlink";

export interface FileDiff {
	readonly path: string;
	readonly status: FileDiffStatus;
	readonly kind: FileDiffKind;
	readonly simplified?: boolean;
	readonly additions: number;
	readonly deletions: number;
	/** 带行号的展示 diff；二进制文件或无逐行差异时为空字符串。 */
	readonly diff: string;
}

export interface CheckpointDiffRequest {
	readonly beforeManifestId: ManifestId;
	readonly afterManifestId: ManifestId;
	readonly changedPaths: readonly string[];
}

const DIFF_BLOB_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const DIFF_PATH_BATCH_MAX_ENTRIES = 2_048;

interface LeafEntry {
	readonly rootPath: string;
	readonly entry: RestorePath;
}

interface ChangedFile {
	readonly path: string;
	readonly status: FileDiffStatus;
	readonly before?: LeafEntry;
	readonly after?: LeafEntry;
}

/** 文件列表只需要树元数据。普通文件正文留到选择文件或生成摘要时读取。 */
export async function prepareCheckpointDiff(source: DiffSource, request: CheckpointDiffRequest) {
	const paths = new Set(request.changedPaths);
	const [before, after] = await Promise.all([request.beforeManifestId, request.afterManifestId].map(async (id) =>
		readLeafEntries(source, await source.loadManifest(id), paths)));
	const files: ChangedFile[] = [];
	for (const path of request.changedPaths) {
		const left = before.get(path);
		const right = after.get(path);
		if (left === undefined && right === undefined) continue;
		const status = left === undefined ? "added" : right === undefined ? "deleted" : "modified";
		files.push({ path, status, before: left, after: right });
	}

	const loadBatch = async (batch: readonly ChangedFile[], includeBody: boolean): Promise<FileDiff[]> => {
		const [oldTexts, newTexts] = await Promise.all([
			readTexts(source, request.beforeManifestId, batch.map((file) => file.before)),
			readTexts(source, request.afterManifestId, batch.map((file) => file.after)),
		]);
		return batch.map(({ path, status, before, after }, i) => {
			const oldText = oldTexts[i];
			const newText = newTexts[i];
			if (oldText === null || newText === null) {
				return { path, status, kind: "binary", additions: 0, deletions: 0, diff: "" };
			}
			const kind = before?.entry.kind === "symlink" || after?.entry.kind === "symlink" ? "symlink" : "text";
			return { path, status, kind, ...compareDiffText(oldText, newText, includeBody) };
		});
	};
	const loadAll = async (includeBody: boolean): Promise<FileDiff[]> => {
		const result: FileDiff[] = [];
		for (const batch of batches(files, (file) => file.path, (file) =>
			(file.before?.entry.size ?? 0) + (file.after?.entry.size ?? 0))) {
			result.push(...await loadBatch(batch, includeBody));
		}
		return result;
	};
	return {
		files,
		loadFile: async (file: ChangedFile) => (await loadBatch([file], true))[0]!,
		loadAll: () => loadAll(true),
		summary: async () => formatDiffSummary(await loadAll(false)),
	};
}

export type CheckpointDiff = Awaited<ReturnType<typeof prepareCheckpointDiff>>;

export async function computeCheckpointDiff(source: DiffSource, request: CheckpointDiffRequest): Promise<FileDiff[]> {
	return (await prepareCheckpointDiff(source, request)).loadAll();
}

/** 同时限制 ls-tree 的参数长度和 cat-file 的响应大小。单个大文件独占一批。 */
function* batches<T>(items: readonly T[], pathOf: (item: T) => string, sizeOf?: (item: T) => number) {
	const maxArgs = process.platform === "win32" ? 24 * 1024 : 128 * 1024;
	let group: T[] = [];
	let args = 0;
	let bytes = 0;
	for (const item of items) {
		const pathBytes = Buffer.byteLength(pathOf(item)) + 16; // 包含 literal pathspec 前缀与分隔符
		const size = sizeOf?.(item) ?? 0;
		if (group.length && (group.length >= DIFF_PATH_BATCH_MAX_ENTRIES ||
			args + pathBytes > maxArgs || bytes + size > DIFF_BLOB_BATCH_MAX_BYTES)) {
			yield group;
			group = [];
			args = 0;
			bytes = 0;
		}
		group.push(item);
		args += pathBytes;
		bytes += size;
	}
	if (group.length) yield group;
}

async function readLeafEntries(source: DiffSource, manifest: SnapshotManifest, paths: ReadonlySet<string>) {
	const scopes = new Map<string, string[]>();
	for (const root of manifest.roots) {
		if (root.state === "active" && root.treeId !== null) scopes.set(root.relativeRoot, []);
	}
	for (const path of paths) {
		if (path === ".") continue;
		// capture 将嵌套 root 从父树排除。按本侧 manifest 选择拥有叶子的最近祖先。
		let root = ".";
		for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
			const parent = path.slice(0, i);
			if (scopes.has(parent)) {
				root = parent;
				break;
			}
		}
		scopes.get(root)?.push(root === "." ? path : path.slice(root.length + 1));
	}
	const leaves = new Map<string, LeafEntry>();
	for (const [rootPath, scope] of scopes) {
		for (const batch of batches(scope, (path) => path)) {
			for (const entry of await source.listTree(manifest.manifestId, rootPath, batch)) {
				if (entry.kind === "directory") continue;
				const path = rootPath === "." ? entry.relativePath : rootPath + "/" + entry.relativePath;
				if (paths.has(path)) leaves.set(path, { rootPath, entry });
			}
		}
	}
	return leaves;
}

async function readTexts(source: DiffSource, id: ManifestId, leaves: readonly (LeafEntry | undefined)[]) {
	const texts: (string | null)[] = [];
	const requests: SnapshotBlobRequest[] = [];
	const indices: number[] = [];
	for (const [i, leaf] of leaves.entries()) {
		if (!leaf) texts[i] = "";
		else if (leaf.entry.kind === "symlink") texts[i] = sanitizeDiffContent(leaf.entry.linkText ?? "");
		else if (leaf.entry.blobId === null) texts[i] = null;
		else {
			requests.push({ rootPath: leaf.rootPath, blobId: leaf.entry.blobId, relativePath: leaf.entry.relativePath });
			indices.push(i);
		}
	}
	if (requests.length) {
		const blobs = await SnapshotStore.readBlobs(source, id, requests);
		for (const [i, bytes] of blobs.entries()) {
			texts[indices[i]!] = bytes.includes(0) || !isUtf8(bytes) ? null :
				sanitizeDiffContent(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
		}
	}
	return texts;
}

function sanitizeDiffContent(text: string): string {
	return text
		.replace(/\x1B/g, "[ESC]")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "?");
}

const STATUS_CHAR: Record<FileDiffStatus, string> = { added: "A", deleted: "D", modified: "M" };

/** 单个文件的一行摘要，用于文件清单与非 TUI 降级展示。 */
export function buildFileLabel(diff: Pick<FileDiff, "path" | "status"> | FileDiff): string {
	const prefix = `${STATUS_CHAR[diff.status]} ${sanitizeDisplayText(diff.path, 240)}`;
	if (!("kind" in diff)) return prefix;
	const stats = diff.kind === "binary"
		? "(binary)"
		: diff.additions === 0 && diff.deletions === 0 ? "(no textual change)" : `+${diff.additions} -${diff.deletions}`;
	return `${prefix}  ${stats}${diff.simplified ? " (block replacement)" : ""}`;
}

/** 整个 checkpoint 的一行摘要，用于非 TUI 模式的 notify。 */
export function formatDiffSummary(diffs: readonly FileDiff[]): string {
	let additions = 0;
	let deletions = 0;
	for (const diff of diffs) {
		additions += diff.additions;
		deletions += diff.deletions;
	}
	const paths = diffs.map((diff) => sanitizeDisplayText(diff.path, 160)).join(", ");
	const simplified = diffs.filter((diff) => diff.simplified).length;
	const note = simplified ? ` (${simplified} block replacement${simplified === 1 ? "" : "s"})` : "";
	return sanitizeDisplayText(`${diffs.length} file(s), +${additions} -${deletions}${note}: ${paths}`, 500);
}

/** 清理可能进入终端 UI 的外部文本，避免 ANSI/控制序列注入。 */
export function sanitizeDisplayText(value: string, maxLength = 200): string {
	return value
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B\][^\u0007]*(?:\u0007|\x1B\\)/g, "")
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}
