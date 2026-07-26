import { generateDiffString } from "@earendil-works/pi-coding-agent";

import type { ManifestId, RestorePath, SnapshotManifest } from "./model.ts";

/** SnapshotStore 的只读子集；/diff 只需要读取 manifest 与 blob，不触碰任何恢复路径。 */
export interface DiffSource {
	loadManifest(id: ManifestId): Promise<SnapshotManifest>;
	listTree(id: ManifestId, root: string): Promise<readonly RestorePath[]>;
	readBlob(id: ManifestId, root: string, blobId: string): Promise<Uint8Array>;
}

export type FileDiffStatus = "added" | "deleted" | "modified";
export type FileDiffKind = "text" | "binary" | "symlink";

export interface FileDiff {
	readonly path: string;
	readonly status: FileDiffStatus;
	readonly kind: FileDiffKind;
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

interface LeafEntry {
	readonly rootPath: string;
	readonly entry: RestorePath;
}

interface LeafContent {
	readonly binary: boolean;
	readonly symlink: boolean;
	readonly text: string;
}

/**
 * 基于 checkpoint 的 before/after 快照计算逐文件 diff。
 * changedPaths 中的目录项与两侧都不存在的路径会被跳过，只保留叶子文件与符号链接。
 */
export async function computeCheckpointDiff(
	source: DiffSource,
	request: CheckpointDiffRequest,
): Promise<FileDiff[]> {
	const [before, after] = await Promise.all([
		source.loadManifest(request.beforeManifestId),
		source.loadManifest(request.afterManifestId),
	]);
	const [beforePaths, afterPaths] = await Promise.all([
		readLeafEntries(source, before),
		readLeafEntries(source, after),
	]);

	const result: FileDiff[] = [];
	for (const path of request.changedPaths) {
		const beforeLeaf = beforePaths.get(path);
		const afterLeaf = afterPaths.get(path);
		if (beforeLeaf === undefined && afterLeaf === undefined) continue;
		const status: FileDiffStatus = beforeLeaf === undefined
			? "added"
			: afterLeaf === undefined ? "deleted" : "modified";
		const beforeContent = beforeLeaf === undefined
			? emptyContent()
			: await readLeafContent(source, request.beforeManifestId, beforeLeaf);
		const afterContent = afterLeaf === undefined
			? emptyContent()
			: await readLeafContent(source, request.afterManifestId, afterLeaf);
		if (beforeContent.binary || afterContent.binary) {
			result.push({ path, status, kind: "binary", additions: 0, deletions: 0, diff: "" });
			continue;
		}
		const kind: FileDiffKind = beforeContent.symlink || afterContent.symlink ? "symlink" : "text";
		const { diff } = generateDiffString(beforeContent.text, afterContent.text);
		result.push({ path, status, kind, ...countChanges(diff), diff });
	}
	return result;
}

async function readLeafEntries(source: DiffSource, manifest: SnapshotManifest): Promise<Map<string, LeafEntry>> {
	const result = new Map<string, LeafEntry>();
	for (const root of manifest.roots) {
		if (root.state !== "active" || root.treeId === null) continue;
		for (const entry of await source.listTree(manifest.manifestId, root.relativeRoot)) {
			if (entry.kind === "directory") continue;
			const path = root.relativeRoot === "." ? entry.relativePath : `${root.relativeRoot}/${entry.relativePath}`;
			if (!result.has(path)) result.set(path, { rootPath: root.relativeRoot, entry });
		}
	}
	return result;
}

async function readLeafContent(source: DiffSource, manifestId: ManifestId, leaf: LeafEntry): Promise<LeafContent> {
	if (leaf.entry.kind === "symlink") {
		return { binary: false, symlink: true, text: sanitizeDiffContent(leaf.entry.linkText ?? "") };
	}
	if (leaf.entry.blobId === null) {
		return { binary: true, symlink: false, text: "" };
	}
	const bytes = await source.readBlob(manifestId, leaf.rootPath, leaf.entry.blobId);
	const text = decodeLossless(bytes);
	return text === null
		? { binary: true, symlink: false, text: "" }
		: { binary: false, symlink: false, text: sanitizeDiffContent(text) };
}

function emptyContent(): LeafContent {
	return { binary: false, symlink: false, text: "" };
}

function decodeLossless(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	const buffer = Buffer.from(bytes);
	const text = buffer.toString("utf8");
	return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}

function sanitizeDiffContent(text: string): string {
	return text
		.replace(/\x1B/g, "[ESC]")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "?");
}

function countChanges(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) additions += 1;
		else if (line.startsWith("-")) deletions += 1;
	}
	return { additions, deletions };
}

const STATUS_CHAR: Record<FileDiffStatus, string> = { added: "A", deleted: "D", modified: "M" };

/** 单个文件的一行摘要，用于文件清单与非 TUI 降级展示。 */
export function buildFileLabel(diff: FileDiff): string {
	const stats = diff.kind === "binary"
		? "(binary)"
		: diff.additions === 0 && diff.deletions === 0 ? "(no textual change)" : `+${diff.additions} -${diff.deletions}`;
	return `${STATUS_CHAR[diff.status]} ${sanitizeDisplayText(diff.path, 240)}  ${stats}`;
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
	return sanitizeDisplayText(`${diffs.length} file(s), +${additions} -${deletions}: ${paths}`, 500);
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
