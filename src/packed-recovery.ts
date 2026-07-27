import { link, lstat, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { fsyncDirectory, writeBytesExclusive } from "./atomic-fs.ts";
import { loadDurablePack, type DurableLeaf } from "./durable-pack.ts";
import type { MutationJournal } from "./mutation-journal.ts";
import type { MutationRecord, MutationState } from "./model.ts";
import { assertNoSymlinkEscape, relativeSafePath } from "./path-safety.ts";
import { fingerprintAbsent, fingerprintFile, fingerprintLeaf } from "./quarantine.ts";

const PACKED_RECOVERY_CONCURRENCY = 32;

const stateOrder: readonly MutationState[] = [
	"INTENT",
	"SOURCE_QUARANTINED",
	"SOURCE_VERIFIED",
	"TARGET_INSTALLED",
	"TARGET_VERIFIED",
	"CLEANED",
];

export async function recoverPackedMutations(options: {
	readonly workspaceRoot: string;
	readonly journal: MutationJournal;
	readonly planDigest: string;
	readonly decision: "rollback" | "roll_forward";
	readonly retainArtifacts?: boolean;
}): Promise<{ readonly kind: "clean" } | { readonly kind: "conflict"; readonly paths: number }> {
	try {
		const workspaceRoot = resolve(options.workspaceRoot);
		const pack = await loadDurablePack(options.journal, options.planDigest, true);
		let records = [...await options.journal.load()];
		if (records.length === 0) {
			records = [...await options.journal.beginMany(pack.paths().map((path) => {
				const artifacts = pack.artifacts(path);
				const sourceFingerprint = pack.sourceFingerprint(path);
				const targetFingerprint = pack.targetFingerprint(path);
				if (
					artifacts === undefined ||
					artifacts.target === null ||
					sourceFingerprint === undefined ||
					targetFingerprint === undefined ||
					targetFingerprint === null
				) {
					throw new Error(`packed recovery intent 缺失：${path}`);
				}
				return {
					kind: "write" as const,
					path,
					sourceArtifact: artifacts.source,
					targetArtifact: artifacts.target,
					sourceFingerprint,
					targetFingerprint,
				};
			}))];
		}
		await mapConcurrent(records, PACKED_RECOVERY_CONCURRENCY, async (record) => {
			if (record.kind !== "write" || record.targetArtifact === null) throw new Error("packed recovery 只支持普通文件 write");
			const source = pack.leaf(record.path, record.sourceFingerprint);
			const target = pack.leaf(record.path, record.targetFingerprint);
			if (source === undefined || target === undefined || target.kind !== "file") {
				throw new Error(`packed recovery variant 缺失：${record.path}`);
			}
			await normalizeRecord(
				workspaceRoot,
				record,
				source,
				target,
				options.decision,
				options.retainArtifacts === true,
			);
		});
		const terminalState: MutationState = options.retainArtifacts === true ? "TARGET_VERIFIED" : "CLEANED";
		const terminalIndex = stateOrder.indexOf(terminalState);
		const advances = records.map((record) => ({
			ordinal: record.ordinal,
			states: stateOrder.slice(stateOrder.indexOf(record.state) + 1, terminalIndex + 1),
		})).filter((advance) => advance.states.length > 0);
		if (advances.length > 0) await options.journal.advanceBatch(advances);
		if (options.retainArtifacts !== true) await options.journal.assertCleaned();
		return { kind: "clean" };
	} catch {
		const active = await options.journal.load().catch(() => []);
		return {
			kind: "conflict",
			paths: Math.max(1, active.filter((record) => record.state !== "CLEANED").length),
		};
	}
}

export async function cleanupPackedMutations(options: {
	readonly workspaceRoot: string;
	readonly journal: MutationJournal;
	readonly planDigest: string;
}): Promise<void> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const pack = await loadDurablePack(options.journal, options.planDigest, true);
	const records = [...await options.journal.load()];
	const cleanupDirectories = new Set<string>();
	await mapConcurrent(records, PACKED_RECOVERY_CONCURRENCY, async (record) => {
		if (
			(record.state !== "TARGET_VERIFIED" && record.state !== "CLEANED") ||
			record.kind !== "write" ||
			record.targetArtifact === null
		) {
			throw new Error(`packed cleanup mutation 状态无效：${record.path}`);
		}
		relativeSafePath(workspaceRoot, record.path);
		await assertNoSymlinkEscape(workspaceRoot, record.path);
		const original = join(workspaceRoot, ...record.path.split("/"));
		const sourceArtifact = join(workspaceRoot, ...record.sourceArtifact.split("/"));
		const targetArtifact = join(workspaceRoot, ...record.targetArtifact.split("/"));
		const source = pack.leaf(record.path, record.sourceFingerprint);
		if (source === undefined) throw new Error(`packed cleanup source variant 缺失：${record.path}`);
		await assertArtifact(sourceArtifact, record.path, record.sourceFingerprint, source.kind === "absent");
		await assertArtifact(targetArtifact, record.path, record.targetFingerprint, false);
		if (await pathExists(targetArtifact)) {
			await assertSameFileIdentity(original, targetArtifact, record.path);
		} else if (record.state !== "CLEANED") {
			throw new Error(`packed cleanup target ownership 缺失：${record.path}`);
		}
		await cleanupArtifact(sourceArtifact, record.path, record.sourceFingerprint, cleanupDirectories);
		await cleanupArtifact(targetArtifact, record.path, record.targetFingerprint, cleanupDirectories);
	});
	for (const directory of cleanupDirectories) await fsyncDirectory(directory);
	const advances = records
		.filter((record) => record.state === "TARGET_VERIFIED")
		.map((record) => ({ ordinal: record.ordinal, states: ["CLEANED" as const] }));
	if (advances.length > 0) await options.journal.advanceBatch(advances);
	await options.journal.assertCleaned();
}

async function normalizeRecord(
	workspaceRoot: string,
	record: MutationRecord,
	source: DurableLeaf,
	target: DurableLeaf,
	decision: "rollback" | "roll_forward",
	retainArtifacts: boolean,
): Promise<void> {
	relativeSafePath(workspaceRoot, record.path);
	await assertNoSymlinkEscape(workspaceRoot, record.path);
	const original = join(workspaceRoot, ...record.path.split("/"));
	const sourceArtifact = join(workspaceRoot, ...record.sourceArtifact.split("/"));
	const targetArtifact = join(workspaceRoot, ...record.targetArtifact!.split("/"));
	const observed = await fingerprintLeaf(original, record.path);
	const absent = fingerprintAbsent(record.path);
	if (observed !== absent && observed !== record.sourceFingerprint && observed !== record.targetFingerprint) {
		throw new Error(`packed recovery original 冲突：${record.path}`);
	}
	await assertArtifact(sourceArtifact, record.path, record.sourceFingerprint, source.kind === "absent");
	await assertArtifact(targetArtifact, record.path, record.targetFingerprint, false);
	if (observed === record.targetFingerprint) {
		if (await pathExists(targetArtifact)) {
			await assertSameFileIdentity(original, targetArtifact, record.path);
		} else if (!(record.state === "CLEANED" && decision === "roll_forward")) {
			throw new Error(`packed recovery target ownership 缺失：${record.path}`);
		}
	}
	const desired = decision === "rollback" ? source : target;
	if (decision === "roll_forward" && observed === record.sourceFingerprint && observed !== absent) {
		throw new Error(`packed recovery source ownership 冲突：${record.path}`);
	}
	if (observed !== desired.fingerprint) {
		if (observed !== absent) {
			await unlink(original);
			await fsyncDirectory(dirname(original));
		}
		await materialize(original, record.path, desired);
		if (retainArtifacts && desired === target) {
			await linkOwnershipMarker(original, targetArtifact, record.path);
		}
	}
	if (!retainArtifacts) {
		await cleanupArtifact(sourceArtifact, record.path, record.sourceFingerprint);
		await cleanupArtifact(targetArtifact, record.path, record.targetFingerprint);
	}
}

async function pathExists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, (error) => {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	});
}

async function assertArtifact(
	path: string,
	logicalPath: string,
	expectedFingerprint: string,
	mustBeAbsent: boolean,
): Promise<void> {
	const exists = await lstat(path).then(() => true, (error) => {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	});
	if (!exists) return;
	if (mustBeAbsent || await fingerprintFile(path, logicalPath) !== expectedFingerprint) {
		throw new Error(`packed recovery artifact 冲突：${logicalPath}`);
	}
}

async function linkOwnershipMarker(original: string, artifact: string, logicalPath: string): Promise<void> {
	try {
		await link(original, artifact);
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
	}
	await assertSameFileIdentity(original, artifact, logicalPath);
	await fsyncDirectory(dirname(artifact));
}

async function assertSameFileIdentity(original: string, artifact: string, logicalPath: string): Promise<void> {
	const [originalMetadata, artifactMetadata] = await Promise.all([lstat(original), lstat(artifact)]);
	if (
		!originalMetadata.isFile() ||
		!artifactMetadata.isFile() ||
		originalMetadata.dev !== artifactMetadata.dev ||
		originalMetadata.ino !== artifactMetadata.ino
	) {
		throw new Error(`packed recovery target ownership 冲突：${logicalPath}`);
	}
}

async function cleanupArtifact(
	path: string,
	logicalPath: string,
	expectedFingerprint: string,
	deferredDirectories?: Set<string>,
): Promise<void> {
	try {
		if (await fingerprintFile(path, logicalPath) !== expectedFingerprint) {
			throw new Error(`packed recovery cleanup artifact 冲突：${logicalPath}`);
		}
		await unlink(path);
		if (deferredDirectories === undefined) {
			await fsyncDirectory(dirname(path));
		} else {
			deferredDirectories.add(dirname(path));
		}
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
}

async function materialize(path: string, logicalPath: string, leaf: DurableLeaf): Promise<void> {
	if (leaf.kind === "absent") return;
	if (leaf.kind !== "file") throw new Error(`packed recovery 暂不支持 symlink：${logicalPath}`);
	await writeBytesExclusive(path, leaf.bytes, leaf.mode);
	if (await fingerprintFile(path, logicalPath) !== leaf.fingerprint) {
		await rm(path, { force: true });
		throw new Error(`packed recovery materialize 校验失败：${logicalPath}`);
	}
}

async function mapConcurrent<T>(
	values: readonly T[],
	concurrency: number,
	worker: (value: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let firstFailure: unknown;
	const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (firstFailure === undefined) {
			const index = next;
			next += 1;
			if (index >= values.length) return;
			try {
				await worker(values[index]!);
			} catch (error) {
				firstFailure = error;
			}
		}
	});
	await Promise.all(runners);
	if (firstFailure !== undefined) throw firstFailure;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
