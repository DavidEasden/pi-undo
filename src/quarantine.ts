import { randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, link, open, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { fsyncDirectory, writeBytesExclusive } from "./atomic-fs.ts";
import { canonicalJson, checksum } from "./encoding.ts";
import type { MutationJournal } from "./mutation-journal.ts";
import type { MutationRecord } from "./model.ts";
import { assertNoSymlinkEscape, relativeSafePath } from "./path-safety.ts";

export interface ReplaceFileRequest {
	readonly path: string;
	readonly targetBytes: Uint8Array;
	readonly targetMode: number;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
	readonly beforeInstall?: () => void | Promise<void>;
}

export interface ReplaceSymlinkRequest {
	readonly path: string;
	readonly targetLinkText: string;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
	readonly beforeInstall?: () => void | Promise<void>;
}

export interface DeleteLeafRequest {
	readonly path: string;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
}

export interface QuarantineArtifact {
	readonly path: string;
	readonly role: "source" | "target";
	readonly fingerprint: string;
	readonly ordinal: number;
}

export type QuarantineErrorCode = "external_concurrency" | "fingerprint_mismatch" | "unsafe_artifact";

export class QuarantineError extends Error {
	readonly code: QuarantineErrorCode;

	constructor(code: QuarantineErrorCode, message: string) {
		super(message);
		this.name = "QuarantineError";
		this.code = code;
	}
}

export class QuarantineManager {
	private readonly requestedWorkspaceRoot: string;
	private readonly workspaceRoot: string;
	private readonly journal: MutationJournal;
	private readonly linkFile: typeof link;
	private readonly nonce: () => string;
	private readonly beforeSourceCapture: (() => void | Promise<void>) | undefined;
	private readonly beforeSourceRemove: (() => void | Promise<void>) | undefined;
	private readonly beforeRestoreInstall: (() => void | Promise<void>) | undefined;
	private readonly beforeRestoreSourceCleanup: (() => void | Promise<void>) | undefined;
	private readonly afterRestoreSourceCleanup: (() => void | Promise<void>) | undefined;
	private readonly beforeTargetCreate: (() => void | Promise<void>) | undefined;

	constructor(options: {
		readonly workspaceRoot: string;
		readonly journal: MutationJournal;
		readonly linkFile?: typeof link;
		readonly nonce?: () => string;
		readonly beforeSourceCapture?: () => void | Promise<void>;
		readonly beforeSourceRemove?: () => void | Promise<void>;
		readonly beforeRestoreInstall?: () => void | Promise<void>;
		readonly beforeRestoreSourceCleanup?: () => void | Promise<void>;
		readonly afterRestoreSourceCleanup?: () => void | Promise<void>;
		readonly beforeTargetCreate?: () => void | Promise<void>;
	}) {
		this.requestedWorkspaceRoot = resolve(options.workspaceRoot);
		this.workspaceRoot = realpathSync(this.requestedWorkspaceRoot);
		this.journal = options.journal;
		this.linkFile = options.linkFile ?? link;
		this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
		this.beforeSourceCapture = options.beforeSourceCapture;
		this.beforeSourceRemove = options.beforeSourceRemove;
		this.beforeRestoreInstall = options.beforeRestoreInstall;
		this.beforeRestoreSourceCleanup = options.beforeRestoreSourceCleanup;
		this.afterRestoreSourceCleanup = options.afterRestoreSourceCleanup;
		this.beforeTargetCreate = options.beforeTargetCreate;
	}

	async replaceFile(request: ReplaceFileRequest): Promise<void> {
		await this.assertWorkspaceIdentity();
		await this.assertPath(request.path);
		assertFingerprint(request.sourceFingerprint);
		assertFingerprint(request.targetFingerprint);
		assertMode(request.targetMode);
		const artifacts = await this.artifactPaths(request.path, true);
		const intent = await this.journal.begin({
			kind: "write",
			path: request.path,
			...artifacts,
			sourceFingerprint: request.sourceFingerprint,
			targetFingerprint: request.targetFingerprint,
		});
		const targetArtifact = this.absolute(artifacts.targetArtifact!);
		await this.beforeTargetCreate?.();
		await this.assertMutationPaths(request.path, artifacts.targetArtifact!);
		await writeBytesExclusive(targetArtifact, request.targetBytes, request.targetMode);
		await this.assertFingerprint(targetArtifact, request.path, request.targetFingerprint);
		await this.quarantineSource(intent);
		await request.beforeInstall?.();
		await this.assertMutationPaths(request.path, artifacts.targetArtifact!);
		await this.assertFingerprint(targetArtifact, request.path, request.targetFingerprint);
		try {
			await this.linkFile(targetArtifact, this.absolute(request.path));
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				throw new QuarantineError("external_concurrency", `检测到外部并发修改：${request.path}`);
			}
			throw error;
		}
		await fsyncDirectory(dirname(this.absolute(request.path)));
		await this.journal.advance(intent.ordinal, "TARGET_INSTALLED");
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		await this.assertArtifactPath(request.path, artifacts.targetArtifact!);
		await unlink(targetArtifact);
		await fsyncDirectory(dirname(targetArtifact));
		await this.journal.advance(intent.ordinal, "TARGET_VERIFIED");
	}

	async replaceSymlink(request: ReplaceSymlinkRequest): Promise<void> {
		await this.assertWorkspaceIdentity();
		await this.assertPath(request.path);
		assertFingerprint(request.sourceFingerprint);
		assertFingerprint(request.targetFingerprint);
		if (fingerprintSymlink(request.path, request.targetLinkText) !== request.targetFingerprint) {
			throw new QuarantineError("fingerprint_mismatch", `symlink target fingerprint 不匹配：${request.path}`);
		}
		const artifacts = await this.artifactPaths(request.path, false);
		const intent = await this.journal.begin({
			kind: "symlink",
			path: request.path,
			...artifacts,
			sourceFingerprint: request.sourceFingerprint,
			targetFingerprint: request.targetFingerprint,
		});
		await this.quarantineSource(intent);
		await request.beforeInstall?.();
		await this.assertMutationPaths(request.path);
		try {
			await symlink(request.targetLinkText, this.absolute(request.path));
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				throw new QuarantineError("external_concurrency", `检测到外部并发修改：${request.path}`);
			}
			throw error;
		}
		await fsyncDirectory(dirname(this.absolute(request.path)));
		await this.journal.advance(intent.ordinal, "TARGET_INSTALLED");
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		await this.journal.advance(intent.ordinal, "TARGET_VERIFIED");
	}

	async deleteLeaf(request: DeleteLeafRequest): Promise<void> {
		await this.assertWorkspaceIdentity();
		await this.assertPath(request.path);
		assertFingerprint(request.sourceFingerprint);
		assertFingerprint(request.targetFingerprint);
		if (request.targetFingerprint !== fingerprintAbsent(request.path)) {
			throw new QuarantineError("fingerprint_mismatch", `删除目标 fingerprint 不是 absent：${request.path}`);
		}
		const artifacts = await this.artifactPaths(request.path, false);
		const intent = await this.journal.begin({
			kind: "delete",
			path: request.path,
			...artifacts,
			sourceFingerprint: request.sourceFingerprint,
			targetFingerprint: request.targetFingerprint,
		});
		await this.quarantineSource(intent);
		await this.journal.advance(intent.ordinal, "TARGET_INSTALLED");
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		await this.journal.advance(intent.ordinal, "TARGET_VERIFIED");
	}

	async restoreMutation(record: MutationRecord): Promise<void> {
		const owned = await this.assertOwnedRecord(record);
		const source = this.absolute(owned.sourceArtifact);
		const original = this.absolute(owned.path);
		await this.assertMutationPaths(owned.path, owned.sourceArtifact);
		const originalFingerprint = await fingerprintLeaf(original, owned.path);
		const sourceExists = await exists(source);
		if (owned.state === "CLEANED") {
			if (originalFingerprint !== owned.sourceFingerprint || sourceExists) {
				throw new QuarantineError("external_concurrency", `已 CLEANED rollback 现场不一致：${owned.path}`);
			}
			await this.assertTargetArtifactAbsent(owned);
			return;
		}
		if (originalFingerprint === owned.sourceFingerprint) {
			if (sourceExists) {
				await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
				await this.assertArtifactPath(owned.path, owned.sourceArtifact);
				await unlink(source);
				await fsyncDirectory(dirname(source));
			}
			await this.cleanupRollbackTarget(owned);
			await this.journal.markRollbackCleaned(owned.ordinal);
			return;
		}
		if (!sourceExists) {
			throw new QuarantineError("external_concurrency", `source 已缺失且原路径不是已恢复内容：${owned.path}`);
		}
		await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
		if (
			originalFingerprint !== fingerprintAbsent(owned.path) &&
			originalFingerprint === owned.targetFingerprint
		) {
			await this.assertMutationPaths(owned.path, owned.sourceArtifact);
			await this.assertFingerprint(original, owned.path, owned.targetFingerprint);
			await unlink(original);
			await fsyncDirectory(dirname(original));
		} else if (originalFingerprint !== fingerprintAbsent(owned.path)) {
			throw new QuarantineError("external_concurrency", `检测到外部并发，恢复路径存在未知内容：${owned.path}`);
		}
		await this.beforeRestoreInstall?.();
		await this.assertMutationPaths(owned.path, owned.sourceArtifact);
		await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
		const metadata = await lstat(source);
		try {
			if (metadata.isSymbolicLink()) {
				await symlink(await readlink(source), original);
			} else if (metadata.isFile()) {
				await link(source, original);
			} else {
				throw new QuarantineError("unsafe_artifact", "source artifact 不是受支持的叶子类型");
			}
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				throw new QuarantineError("external_concurrency", `检测到外部并发，恢复路径已存在：${owned.path}`);
			}
			throw error;
		}
		await fsyncDirectory(dirname(original));
		await this.assertFingerprint(original, owned.path, owned.sourceFingerprint);
		await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
		await this.beforeRestoreSourceCleanup?.();
		await this.assertMutationPaths(owned.path, owned.sourceArtifact);
		await unlink(source);
		await fsyncDirectory(dirname(source));
		await this.afterRestoreSourceCleanup?.();
		await this.cleanupRollbackTarget(owned);
		await this.journal.markRollbackCleaned(owned.ordinal);
	}

	async rollForwardMutation(record: MutationRecord): Promise<void> {
		let owned = await this.assertOwnedRecord(record);
		if (owned.state === "SOURCE_QUARANTINED") {
			await this.assertFingerprint(this.absolute(owned.sourceArtifact), owned.path, owned.sourceFingerprint);
			owned = await this.journal.advance(owned.ordinal, "SOURCE_VERIFIED");
		}
		if (owned.state === "SOURCE_VERIFIED") {
			if (owned.kind === "write" && owned.targetArtifact !== null) {
				const targetArtifact = this.absolute(owned.targetArtifact);
				await this.assertMutationPaths(owned.path, owned.targetArtifact);
				await this.assertFingerprint(targetArtifact, owned.path, owned.targetFingerprint);
				try {
					await this.linkFile(targetArtifact, this.absolute(owned.path));
				} catch (error) {
					if (!hasErrorCode(error, "EEXIST")) throw error;
					await this.assertFingerprint(this.absolute(owned.path), owned.path, owned.targetFingerprint)
						.catch(() => {
							throw new QuarantineError("external_concurrency", `检测到外部并发修改：${owned.path}`);
						});
				}
				await fsyncDirectory(dirname(this.absolute(owned.path)));
			} else if (owned.kind === "delete") {
				await this.assertFingerprint(this.absolute(owned.path), owned.path, owned.targetFingerprint);
			} else {
				throw new QuarantineError("unsafe_artifact", "symlink 缺少可重建 target，不能仅凭 fingerprint roll forward");
			}
			owned = await this.journal.advance(owned.ordinal, "TARGET_INSTALLED");
		}
		if (owned.state === "TARGET_INSTALLED") {
			await this.assertFingerprint(this.absolute(owned.path), owned.path, owned.targetFingerprint);
			if (owned.targetArtifact !== null && await exists(this.absolute(owned.targetArtifact))) {
				await this.assertArtifactPath(owned.path, owned.targetArtifact);
				await this.assertFingerprint(this.absolute(owned.targetArtifact), owned.path, owned.targetFingerprint);
				await unlink(this.absolute(owned.targetArtifact));
				await fsyncDirectory(dirname(this.absolute(owned.targetArtifact)));
			}
			await this.journal.advance(owned.ordinal, "TARGET_VERIFIED");
			return;
		}
		if (owned.state !== "TARGET_VERIFIED" && owned.state !== "CLEANED") {
			throw new QuarantineError("unsafe_artifact", `mutation 状态不能 roll forward：${owned.state}`);
		}
	}

	async cleanupMutation(record: MutationRecord): Promise<void> {
		const owned = await this.assertOwnedRecord(record);
		if (owned.state === "CLEANED") return;
		if (owned.state !== "TARGET_VERIFIED") {
			throw new QuarantineError("unsafe_artifact", "只有 TARGET_VERIFIED mutation 可以清理");
		}
		const source = this.absolute(owned.sourceArtifact);
		if (await exists(source)) {
			await this.assertArtifactPath(owned.path, owned.sourceArtifact);
			await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
			await unlink(source);
			await fsyncDirectory(dirname(source));
		}
		if (owned.targetArtifact !== null) {
			const target = this.absolute(owned.targetArtifact);
			if (await exists(target)) {
				await this.assertArtifactPath(owned.path, owned.targetArtifact);
				await this.assertFingerprint(target, owned.path, owned.targetFingerprint);
				await unlink(target);
				await fsyncDirectory(dirname(target));
			}
		}
		await this.journal.advance(owned.ordinal, "CLEANED");
	}

	async inspectArtifacts(): Promise<readonly QuarantineArtifact[]> {
		const result: QuarantineArtifact[] = [];
		for (const record of await this.journal.load()) {
			if (record.state === "CLEANED") continue;
			const artifacts: Array<readonly [QuarantineArtifact["role"], string, string]> = [
				["source", record.sourceArtifact, record.sourceFingerprint],
			];
			if (record.targetArtifact !== null) {
				artifacts.push(["target", record.targetArtifact, record.targetFingerprint]);
			}
			for (const [role, path] of artifacts) {
				await this.assertArtifactPath(record.path, path);
				if (!await exists(this.absolute(path))) continue;
				const fingerprint = await fingerprintLeaf(this.absolute(path), record.path);
				result.push({ path, role, fingerprint, ordinal: record.ordinal });
			}
		}
		return result;
	}

	private async quarantineSource(record: MutationRecord): Promise<void> {
		const original = this.absolute(record.path);
		const source = this.absolute(record.sourceArtifact);
		await this.assertFingerprint(original, record.path, record.sourceFingerprint);
		const metadata = await lstat(original);
		const linkText = metadata.isSymbolicLink() ? await readlink(original) : undefined;
		if (!metadata.isFile() && !metadata.isSymbolicLink()) {
			throw new QuarantineError("unsafe_artifact", "quarantine 只支持普通文件和 symlink");
		}
		await this.beforeSourceCapture?.();
		await this.assertMutationPaths(record.path, record.sourceArtifact);
		try {
			if (linkText === undefined) {
				await link(original, source);
			} else {
				await symlink(linkText, source);
			}
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				throw new QuarantineError("external_concurrency", `检测到外部并发，source artifact 被抢占：${record.path}`);
			}
			throw error;
		}
		await fsyncDirectory(dirname(original));
		await this.beforeSourceRemove?.();
		await this.assertMutationPaths(record.path, record.sourceArtifact);
		await this.assertFingerprint(source, record.path, record.sourceFingerprint);
		await this.assertFingerprint(original, record.path, record.sourceFingerprint);
		if (linkText === undefined) {
			const [sourceMetadata, originalMetadata] = await Promise.all([lstat(source), lstat(original)]);
			if (sourceMetadata.dev !== originalMetadata.dev || sourceMetadata.ino !== originalMetadata.ino) {
				throw new QuarantineError("external_concurrency", `source 隔离前原路径已变化：${record.path}`);
			}
		}
		await unlink(original);
		await fsyncDirectory(dirname(original));
		await this.journal.advance(record.ordinal, "SOURCE_QUARANTINED");
		await this.assertFingerprint(source, record.path, record.sourceFingerprint);
		await this.journal.advance(record.ordinal, "SOURCE_VERIFIED");
	}

	private async cleanupRollbackTarget(record: MutationRecord): Promise<void> {
		if (record.targetArtifact === null) return;
		const target = this.absolute(record.targetArtifact);
		if (!await exists(target)) return;
		await this.assertArtifactPath(record.path, record.targetArtifact);
		await this.assertFingerprint(target, record.path, record.targetFingerprint);
		await unlink(target);
		await fsyncDirectory(dirname(target));
	}

	private async assertTargetArtifactAbsent(record: MutationRecord): Promise<void> {
		if (record.targetArtifact !== null && await exists(this.absolute(record.targetArtifact))) {
			throw new QuarantineError("unsafe_artifact", `已 CLEANED mutation 仍存在 target artifact：${record.path}`);
		}
	}

	private async artifactPaths(path: string, withTarget: boolean): Promise<{
		readonly sourceArtifact: string;
		readonly targetArtifact: string | null;
	}> {
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const relative = (name: string): string => parent === "" ? name : `${parent}/${name}`;
		for (let attempt = 0; attempt < 128; attempt += 1) {
			const nonce = this.nonce();
			if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("artifact nonce 无效");
			const candidate = {
				sourceArtifact: relative(`.pi-undo-q1-${nonce}-source`),
				targetArtifact: withTarget ? relative(`.pi-undo-q1-${nonce}-target`) : null,
			};
			if (
				!await exists(this.absolute(candidate.sourceArtifact)) &&
				(candidate.targetArtifact === null || !await exists(this.absolute(candidate.targetArtifact)))
			) {
				return candidate;
			}
		}
		throw new QuarantineError("unsafe_artifact", "无法分配无碰撞 quarantine artifact");
	}

	private async assertOwnedRecord(record: MutationRecord): Promise<MutationRecord> {
		await this.assertWorkspaceIdentity();
		const owned = (await this.journal.load()).find((candidate) => candidate.ordinal === record.ordinal);
		if (owned === undefined || immutableMutation(owned) !== immutableMutation(record)) {
			throw new QuarantineError("unsafe_artifact", "mutation record 未被当前 journal 精确登记");
		}
		await this.assertPath(owned.path);
		await this.assertArtifactPath(owned.path, owned.sourceArtifact);
		if (owned.targetArtifact !== null) await this.assertArtifactPath(owned.path, owned.targetArtifact);
		return owned;
	}

	private async assertPath(path: string): Promise<void> {
		assertNotGitMetadata(path);
		relativeSafePath(this.workspaceRoot, path);
		await assertNoSymlinkEscape(this.workspaceRoot, path);
	}

	private async assertMutationPaths(...paths: readonly string[]): Promise<void> {
		await this.assertWorkspaceIdentity();
		for (const path of paths) await this.assertPath(path);
	}

	private async assertArtifactPath(path: string, artifact: string): Promise<void> {
		await this.assertPath(artifact);
		if (dirname(path) !== dirname(artifact) || !/^\.pi-undo-q1-[0-9a-f]{32}-(source|target)$/.test(artifact.split("/").at(-1)!)) {
			throw new QuarantineError("unsafe_artifact", "artifact 路径或名称无效");
		}
	}

	private async assertFingerprint(absolutePath: string, logicalPath: string, expected: string): Promise<void> {
		const actual = await fingerprintLeaf(absolutePath, logicalPath);
		if (actual !== expected) {
			throw new QuarantineError("fingerprint_mismatch", `路径 fingerprint 不匹配：${logicalPath}`);
		}
	}

	private async assertWorkspaceIdentity(): Promise<void> {
		const identity = await realpath(this.requestedWorkspaceRoot);
		if (identity !== this.workspaceRoot) {
			throw new QuarantineError("unsafe_artifact", "workspace root identity 已变化");
		}
	}

	private absolute(path: string): string {
		return join(this.workspaceRoot, ...path.split("/"));
	}
}

export function fingerprintBytes(path: string, bytes: Uint8Array, mode: number): string {
	return checksum(canonicalJson({
		path,
		kind: "file",
		mode: (mode & 0o111) === 0 ? 0o644 : 0o755,
		content: checksum(bytes),
	}));
}

export async function fingerprintFile(file: string, logicalPath: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new Error("fingerprint 目标不是普通文件");
		return fingerprintBytes(logicalPath, await handle.readFile(), metadata.mode);
	} finally {
		await handle.close();
	}
}

export function fingerprintSymlink(path: string, linkText: string): string;
export function fingerprintSymlink(file: string, logicalPath: string): Promise<string>;
export function fingerprintSymlink(fileOrPath: string, linkTextOrPath: string): string | Promise<string> {
	if (!fileOrPath.startsWith("/")) {
		return checksum(canonicalJson({ path: fileOrPath, kind: "symlink", linkText: linkTextOrPath }));
	}
	return readlink(fileOrPath).then((linkText) =>
		checksum(canonicalJson({ path: linkTextOrPath, kind: "symlink", linkText })),
	);
}

export function fingerprintAbsent(path: string): string {
	return checksum(canonicalJson({ path, kind: "absent" }));
}

async function fingerprintLeaf(file: string, logicalPath: string): Promise<string> {
	const metadata = await lstat(file).catch((error) => {
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return null;
		throw error;
	});
	if (metadata === null) return fingerprintAbsent(logicalPath);
	if (metadata.isSymbolicLink()) return fingerprintSymlink(file, logicalPath);
	if (metadata.isFile()) return fingerprintFile(file, logicalPath);
	throw new Error(`quarantine 只支持普通文件和 symlink：${logicalPath}`);
}

function assertNotGitMetadata(path: string): void {
	if (path.split("/").some((part) => part.toLowerCase() === ".git")) {
		throw new QuarantineError("unsafe_artifact", "不能修改真实 Git metadata");
	}
}

function assertFingerprint(value: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("fingerprint 无效");
}

function assertMode(mode: number): void {
	if (mode !== 0o644 && mode !== 0o755) throw new Error("文件 mode 必须是 0644 或 0755");
}

function immutableMutation(record: MutationRecord): string {
	return canonicalJson({
		opId: record.opId,
		ordinal: record.ordinal,
		kind: record.kind,
		path: record.path,
		sourceArtifact: record.sourceArtifact,
		targetArtifact: record.targetArtifact,
		sourceFingerprint: record.sourceFingerprint,
		targetFingerprint: record.targetFingerprint,
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
		throw error;
	}
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
