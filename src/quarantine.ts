import { randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, link, open, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { fsyncDirectory, writeBytesExclusive } from "./atomic-fs.ts";
import { canonicalJson, checksum } from "./encoding.ts";
import type { MutationJournal } from "./mutation-journal.ts";
import type { MutationRecord } from "./model.ts";
import { assertNoSymlinkEscape, relativeSafePath } from "./path-safety.ts";

const BATCH_FILE_IO_CONCURRENCY = 32;

export interface ReplaceFileRequest {
	readonly path: string;
	readonly targetBytes: Uint8Array;
	readonly targetMode: number;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
	readonly beforeInstall?: () => void | Promise<void>;
}

interface PreparedFileReplacement {
	readonly request: ReplaceFileRequest;
	readonly sourceArtifact: string;
	readonly targetArtifact: string;
	readonly targetAbsolutePath: string;
	readonly intent: MutationRecord;
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
	private readonly syncTargetArtifacts: boolean;

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
		readonly syncTargetArtifacts?: boolean;
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
		this.syncTargetArtifacts = options.syncTargetArtifacts ?? true;
	}

	async replaceFile(request: ReplaceFileRequest): Promise<MutationRecord> {
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
		await writeBytesExclusive(
			targetArtifact,
			request.targetBytes,
			request.targetMode,
			{ syncDirectory: false, syncFile: this.syncTargetArtifacts },
		);
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
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		await this.assertArtifactPath(request.path, artifacts.targetArtifact!);
		const targetStates = await this.journal.advanceMany(
			intent.ordinal,
			["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"],
		);
		await unlink(targetArtifact);
		return targetStates.at(-1)!;
	}

	async replaceFiles(requests: readonly ReplaceFileRequest[]): Promise<void> {
		if (requests.length === 0) return;
		const prepared: Array<Omit<PreparedFileReplacement, "intent">> = [];
		for (const request of requests) {
			await this.assertWorkspaceIdentity();
			await this.assertPath(request.path);
			assertFingerprint(request.sourceFingerprint);
			assertFingerprint(request.targetFingerprint);
			assertMode(request.targetMode);
			const artifacts = await this.artifactPaths(request.path, true);
			prepared.push({
				request,
				sourceArtifact: artifacts.sourceArtifact,
				targetArtifact: artifacts.targetArtifact!,
				targetAbsolutePath: this.absolute(artifacts.targetArtifact!),
			});
		}
		const intents = await this.journal.beginMany(prepared.map(({ request, sourceArtifact, targetArtifact }) => ({
			kind: "write" as const,
			path: request.path,
			sourceArtifact,
			targetArtifact,
			sourceFingerprint: request.sourceFingerprint,
			targetFingerprint: request.targetFingerprint,
		})));
		const replacements: PreparedFileReplacement[] = prepared.map((replacement, index) => ({
			...replacement,
			intent: intents[index]!,
		}));
		const createTarget = async (replacement: PreparedFileReplacement): Promise<void> => {
			await this.beforeTargetCreate?.();
			await this.assertMutationPaths(replacement.request.path, replacement.targetArtifact);
			await writeBytesExclusive(
				replacement.targetAbsolutePath,
				replacement.request.targetBytes,
				replacement.request.targetMode,
				{ syncDirectory: false, syncFile: this.syncTargetArtifacts },
			);
			await this.assertFingerprint(
				replacement.targetAbsolutePath,
				replacement.request.path,
				replacement.request.targetFingerprint,
			);
		};
		if (this.beforeTargetCreate === undefined) {
			await mapConcurrentFailClosed(replacements, BATCH_FILE_IO_CONCURRENCY, createTarget);
		} else {
			for (const replacement of replacements) await createTarget(replacement);
		}
		await this.quarantineFileSources(replacements);
		const installDirectories = new Set<string>();
		const installTarget = async (replacement: PreparedFileReplacement): Promise<void> => {
			const { request, targetArtifact, targetAbsolutePath } = replacement;
			await request.beforeInstall?.();
			await this.assertMutationPaths(request.path, targetArtifact);
			await this.assertFingerprint(targetAbsolutePath, request.path, request.targetFingerprint);
			try {
				await this.linkFile(targetAbsolutePath, this.absolute(request.path));
			} catch (error) {
				if (hasErrorCode(error, "EEXIST")) {
					throw new QuarantineError("external_concurrency", `检测到外部并发修改：${request.path}`);
				}
				throw error;
			}
			installDirectories.add(dirname(this.absolute(request.path)));
		};
		if (replacements.some(({ request }) => request.beforeInstall !== undefined)) {
			for (const replacement of replacements) await installTarget(replacement);
		} else {
			await mapConcurrentFailClosed(replacements, BATCH_FILE_IO_CONCURRENCY, installTarget);
		}
		await syncDirectories(installDirectories);
		await mapConcurrentFailClosed(replacements, BATCH_FILE_IO_CONCURRENCY, async (replacement) => {
			const { request, targetArtifact, targetAbsolutePath } = replacement;
			await this.assertArtifactPath(request.path, targetArtifact);
			await this.assertSameFileIdentity(this.absolute(request.path), targetAbsolutePath, request.path);
			await this.assertFingerprint(targetAbsolutePath, request.path, request.targetFingerprint);
		});
		const targetRecords = await this.journal.advanceBatch(replacements.map(({ intent }) => ({
			ordinal: intent.ordinal,
			states: ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"],
		})));
		const verifiedByOrdinal = new Map(
			targetRecords.filter((record) => record.state === "TARGET_VERIFIED")
				.map((record) => [record.ordinal, record]),
		);
		const verifiedRecords: MutationRecord[] = [];
		for (const replacement of replacements) {
			const verified = verifiedByOrdinal.get(replacement.intent.ordinal);
			if (verified === undefined) throw new Error("批量 TARGET_VERIFIED record 缺失");
			verifiedRecords.push(await this.assertOwnedRecord(verified));
		}
		await this.cleanupVerifiedArtifactsBatch(verifiedRecords);
		await this.journal.advanceBatch(replacements.map(({ intent }) => ({
			ordinal: intent.ordinal,
			states: ["CLEANED"],
		})));
	}

	private async quarantineFileSources(
		replacements: readonly { readonly intent: MutationRecord }[],
	): Promise<void> {
		const absentSources = replacements.filter(
			({ intent }) => intent.sourceFingerprint === fingerprintAbsent(intent.path),
		);
		await mapConcurrentFailClosed(absentSources, BATCH_FILE_IO_CONCURRENCY, async ({ intent }) => {
			await this.assertFingerprint(this.absolute(intent.path), intent.path, intent.sourceFingerprint);
			if (await exists(this.absolute(intent.sourceArtifact))) {
				throw new QuarantineError("unsafe_artifact", `absent source 不应存在 artifact：${intent.path}`);
			}
		});
		const presentSources = replacements.filter(
			({ intent }) => intent.sourceFingerprint !== fingerprintAbsent(intent.path),
		);
		const capturedDirectories = new Set<string>();
		const captureSource = async ({ intent }: { readonly intent: MutationRecord }): Promise<void> => {
			const original = this.absolute(intent.path);
			const source = this.absolute(intent.sourceArtifact);
			await this.assertFingerprint(original, intent.path, intent.sourceFingerprint);
			const metadata = await lstat(original);
			if (!metadata.isFile()) throw new QuarantineError("unsafe_artifact", "批量 quarantine 只支持普通文件");
			await this.beforeSourceCapture?.();
			await this.assertMutationPaths(intent.path, intent.sourceArtifact);
			try {
				await link(original, source);
			} catch (error) {
				if (hasErrorCode(error, "EEXIST")) {
					throw new QuarantineError("external_concurrency", `source artifact 被抢占：${intent.path}`);
				}
				throw error;
			}
			capturedDirectories.add(dirname(original));
		};
		if (this.beforeSourceCapture === undefined) {
			await mapConcurrentFailClosed(presentSources, BATCH_FILE_IO_CONCURRENCY, captureSource);
		} else {
			for (const replacement of presentSources) await captureSource(replacement);
		}
		await syncDirectories(capturedDirectories);

		const removedDirectories = new Set<string>();
		const removeSource = async ({ intent }: { readonly intent: MutationRecord }): Promise<void> => {
			const original = this.absolute(intent.path);
			const source = this.absolute(intent.sourceArtifact);
			await this.beforeSourceRemove?.();
			await this.assertMutationPaths(intent.path, intent.sourceArtifact);
			await this.assertFingerprint(source, intent.path, intent.sourceFingerprint);
			await this.assertFingerprint(original, intent.path, intent.sourceFingerprint);
			await this.assertSameFileIdentity(original, source, intent.path);
			await unlink(original);
			removedDirectories.add(dirname(original));
		};
		if (this.beforeSourceRemove === undefined) {
			await mapConcurrentFailClosed(presentSources, BATCH_FILE_IO_CONCURRENCY, removeSource);
		} else {
			for (const replacement of presentSources) await removeSource(replacement);
		}
		await syncDirectories(removedDirectories);
		await mapConcurrentFailClosed(presentSources, BATCH_FILE_IO_CONCURRENCY, async ({ intent }) => {
			await this.assertFingerprint(this.absolute(intent.path), intent.path, fingerprintAbsent(intent.path));
			await this.assertFingerprint(
				this.absolute(intent.sourceArtifact),
				intent.path,
				intent.sourceFingerprint,
			);
		});
	}

	private async cleanupVerifiedArtifactsBatch(records: readonly MutationRecord[]): Promise<void> {
		const directories = new Set<string>();
		await mapConcurrentFailClosed(records, BATCH_FILE_IO_CONCURRENCY, async (owned) => {
			if (owned.state !== "TARGET_VERIFIED") {
				throw new QuarantineError("unsafe_artifact", "只有 TARGET_VERIFIED mutation 可以批量清理");
			}
			if (owned.targetArtifact === null) {
				await this.assertFingerprint(this.absolute(owned.path), owned.path, owned.targetFingerprint);
			} else {
				const target = this.absolute(owned.targetArtifact);
				await this.assertArtifactPath(owned.path, owned.targetArtifact);
				await this.assertSameFileIdentity(this.absolute(owned.path), target, owned.path);
				await this.assertFingerprint(target, owned.path, owned.targetFingerprint);
			}
			const source = this.absolute(owned.sourceArtifact);
			if (await exists(source)) {
				await this.assertArtifactPath(owned.path, owned.sourceArtifact);
				await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
				await unlink(source);
				directories.add(dirname(source));
			}
			if (owned.targetArtifact !== null) {
				const target = this.absolute(owned.targetArtifact);
				if (await exists(target)) {
					await this.assertArtifactPath(owned.path, owned.targetArtifact);
					await this.assertFingerprint(target, owned.path, owned.targetFingerprint);
					await unlink(target);
					directories.add(dirname(target));
				}
			}
		});
		await syncDirectories(directories);
	}

	async replaceSymlink(request: ReplaceSymlinkRequest): Promise<MutationRecord> {
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
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		return (await this.journal.advanceMany(
			intent.ordinal,
			["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"],
		)).at(-1)!;
	}

	async deleteLeaf(request: DeleteLeafRequest): Promise<MutationRecord> {
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
		await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		return (await this.journal.advanceMany(
			intent.ordinal,
			["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"],
		)).at(-1)!;
	}

	async deleteFiles(requests: readonly DeleteLeafRequest[]): Promise<void> {
		if (requests.length === 0) return;
		const prepared: Array<{
			readonly request: DeleteLeafRequest;
			readonly sourceArtifact: string;
		}> = [];
		for (const request of requests) {
			await this.assertWorkspaceIdentity();
			await this.assertPath(request.path);
			assertFingerprint(request.sourceFingerprint);
			assertFingerprint(request.targetFingerprint);
			if (request.targetFingerprint !== fingerprintAbsent(request.path)) {
				throw new QuarantineError("fingerprint_mismatch", `删除目标 fingerprint 不是 absent：${request.path}`);
			}
			const artifacts = await this.artifactPaths(request.path, false);
			prepared.push({ request, sourceArtifact: artifacts.sourceArtifact });
		}
		const intents = await this.journal.beginMany(prepared.map(({ request, sourceArtifact }) => ({
			kind: "delete" as const,
			path: request.path,
			sourceArtifact,
			targetArtifact: null,
			sourceFingerprint: request.sourceFingerprint,
			targetFingerprint: request.targetFingerprint,
		})));
		const mutations = intents.map((intent) => ({ intent }));
		await this.quarantineFileSources(mutations);
		for (const { request } of prepared) {
			await this.assertFingerprint(this.absolute(request.path), request.path, request.targetFingerprint);
		}
		const targetRecords = await this.journal.advanceBatch(intents.map((intent) => ({
			ordinal: intent.ordinal,
			states: ["SOURCE_QUARANTINED", "SOURCE_VERIFIED", "TARGET_INSTALLED", "TARGET_VERIFIED"],
		})));
		const verifiedRecords: MutationRecord[] = [];
		for (const record of targetRecords) {
			if (record.state === "TARGET_VERIFIED") {
				verifiedRecords.push(await this.assertOwnedRecord(record));
			}
		}
		if (verifiedRecords.length !== intents.length) {
			throw new Error("批量 delete TARGET_VERIFIED record 缺失");
		}
		await this.cleanupVerifiedArtifactsBatch(verifiedRecords);
		await this.journal.advanceBatch(intents.map((intent) => ({
			ordinal: intent.ordinal,
			states: ["CLEANED"],
		})));
	}

	async restoreMutation(record: MutationRecord): Promise<void> {
		const owned = await this.assertOwnedRecord(record);
		const source = this.absolute(owned.sourceArtifact);
		const original = this.absolute(owned.path);
		await this.assertMutationPaths(owned.path, owned.sourceArtifact);
		const originalFingerprint = await fingerprintLeaf(original, owned.path);
		const sourceExists = await exists(source);
		const sourceWasAbsent = owned.sourceFingerprint === fingerprintAbsent(owned.path);
		if (owned.state === "CLEANED") {
			if (originalFingerprint !== owned.sourceFingerprint || sourceExists) {
				throw new QuarantineError("external_concurrency", `已 CLEANED rollback 现场不一致：${owned.path}`);
			}
			await this.assertTargetArtifactAbsent(owned);
			return;
		}
		if (
			owned.state === "TARGET_VERIFIED" && !sourceWasAbsent && !sourceExists &&
			originalFingerprint === owned.targetFingerprint
		) {
			await this.cleanupRollbackTarget(owned);
			await this.journal.markRollbackCleaned(owned.ordinal);
			return;
		}
		if (sourceWasAbsent) {
			if (sourceExists) {
				throw new QuarantineError("unsafe_artifact", `absent source 不应存在 artifact：${owned.path}`);
			}
			if (originalFingerprint === owned.targetFingerprint) {
				await this.assertRollbackTargetOwned(owned);
				await this.assertFingerprint(original, owned.path, owned.targetFingerprint);
				await unlink(original);
				await fsyncDirectory(dirname(original));
			} else if (originalFingerprint !== owned.sourceFingerprint) {
				throw new QuarantineError("external_concurrency", `检测到外部并发，恢复路径存在未知内容：${owned.path}`);
			}
			await this.cleanupRollbackTarget(owned);
			await this.journal.markRollbackCleaned(owned.ordinal);
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
			await this.assertRollbackTargetOwned(owned);
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
		if (owned.state === "INTENT") {
			const source = this.absolute(owned.sourceArtifact);
			const original = this.absolute(owned.path);
			const originalFingerprint = await fingerprintLeaf(original, owned.path);
			if (owned.sourceFingerprint === fingerprintAbsent(owned.path)) {
				if (await exists(source) || originalFingerprint !== owned.sourceFingerprint) {
					throw new QuarantineError("external_concurrency", `INTENT absent source 现场冲突：${owned.path}`);
				}
			} else {
				await this.assertFingerprint(source, owned.path, owned.sourceFingerprint);
				if (originalFingerprint === owned.sourceFingerprint) {
					const [sourceMetadata, originalMetadata] = await Promise.all([lstat(source), lstat(original)]);
					if (
					sourceMetadata.isFile() &&
					(sourceMetadata.dev !== originalMetadata.dev || sourceMetadata.ino !== originalMetadata.ino)
					) {
						throw new QuarantineError("external_concurrency", `INTENT source inode 冲突：${owned.path}`);
					}
					await unlink(original);
					await fsyncDirectory(dirname(original));
				} else if (originalFingerprint !== fingerprintAbsent(owned.path)) {
					throw new QuarantineError("external_concurrency", `INTENT original 现场冲突：${owned.path}`);
				}
			}
			owned = (await this.journal.advanceMany(
				owned.ordinal,
				["SOURCE_QUARANTINED", "SOURCE_VERIFIED"],
			)).at(-1)!;
		}
		if (owned.state === "SOURCE_QUARANTINED") {
			if (owned.sourceFingerprint === fingerprintAbsent(owned.path)) {
				if (await exists(this.absolute(owned.sourceArtifact))) {
					throw new QuarantineError("unsafe_artifact", `absent source 不应存在 artifact：${owned.path}`);
				}
			} else {
				await this.assertFingerprint(this.absolute(owned.sourceArtifact), owned.path, owned.sourceFingerprint);
			}
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
		await this.cleanupVerifiedArtifacts(owned);
		await this.journal.advance(owned.ordinal, "CLEANED");
	}

	private async cleanupVerifiedArtifacts(owned: MutationRecord): Promise<void> {
		if (owned.state !== "TARGET_VERIFIED") {
			throw new QuarantineError("unsafe_artifact", "只有 TARGET_VERIFIED mutation 可以清理");
		}
		await this.assertFingerprint(this.absolute(owned.path), owned.path, owned.targetFingerprint);
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
		if (record.sourceFingerprint === fingerprintAbsent(record.path)) {
			if (await exists(source)) {
				throw new QuarantineError("unsafe_artifact", `absent source 不应存在 artifact：${record.path}`);
			}
			await this.assertFingerprint(original, record.path, record.sourceFingerprint);
			return;
		}
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
		await this.assertFingerprint(source, record.path, record.sourceFingerprint);
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
		const owned = await this.journal.loadOrdinal(record.ordinal);
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

	private async assertRollbackTargetOwned(owned: MutationRecord): Promise<void> {
		if (owned.targetArtifact === null) return;
		const target = this.absolute(owned.targetArtifact);
		if (!await exists(target)) return;
		await this.assertArtifactPath(owned.path, owned.targetArtifact);
		await this.assertFingerprint(target, owned.path, owned.targetFingerprint);
		await this.assertSameFileIdentity(this.absolute(owned.path), target, owned.path);
	}

	private async assertSameFileIdentity(original: string, artifact: string, path: string): Promise<void> {
		const [originalMetadata, artifactMetadata] = await Promise.all([lstat(original), lstat(artifact)]);
		if (
			!originalMetadata.isFile() ||
			!artifactMetadata.isFile() ||
			originalMetadata.dev !== artifactMetadata.dev ||
			originalMetadata.ino !== artifactMetadata.ino
		) {
			throw new QuarantineError("external_concurrency", `target artifact ownership 已变化：${path}`);
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

export async function fingerprintLeaf(file: string, logicalPath: string): Promise<string> {
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

async function mapConcurrentFailClosed<T>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	let failed = false;
	let failure: unknown;
	async function worker(): Promise<void> {
		while (!failed && nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				await operation(values[index]!);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
	);
	if (failed) throw failure;
}

async function syncDirectories(directories: ReadonlySet<string>): Promise<void> {
	for (const directory of directories) await fsyncDirectory(directory);
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
