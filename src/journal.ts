import { appendFile, lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fsyncDirectory, fsyncFile, writeContentAddressed, writeJsonAtomic } from "./atomic-fs.ts";
import {
	assertCursor,
	assertJournalState,
	assertOperationDescriptor,
	canonicalJson,
	checksum,
} from "./encoding.ts";
import type {
	CursorState,
	JournalPhase,
	JournalState,
	OperationDescriptor,
} from "./model.ts";

export interface PendingJournal {
	readonly descriptor: OperationDescriptor;
	readonly plan: unknown;
	readonly state: JournalState;
}

export interface JournalStoreOptions {
	readonly transactionsRoot: string;
}

export interface JournalPhaseOptions {
	readonly observedLogicalLeaf?: string | null;
}

export type CursorMarkerInspection =
	| { readonly kind: "absent" }
	| { readonly kind: "match"; readonly needsTrailingNewline: boolean }
	| { readonly kind: "conflict" };

export interface RecoveryDecision {
	readonly action: "rollback" | "roll_forward" | "lock" | "discard";
	readonly reason: string;
}

export class JournalStore {
	private readonly transactionsRoot: string;

	constructor(options: JournalStoreOptions) {
		this.transactionsRoot = options.transactionsRoot;
	}

	async prepare(descriptor: OperationDescriptor, plan: unknown): Promise<void> {
		assertOperationDescriptor(descriptor);
		if (!isPlanForDescriptor(plan, descriptor)) {
			throw new Error("restore plan 与 descriptor 不匹配");
		}
		const directory = this.operationDirectory(descriptor.opId);
		await writeContentAddressed(join(directory, "descriptor.json"), Buffer.from(canonicalJson(descriptor), "utf8"));
		await writeContentAddressed(join(directory, "restore-plan.json"), Buffer.from(canonicalJson(plan), "utf8"));
		const statePath = join(directory, "state.json");
		try {
			const existing = assertJournalState(JSON.parse(await readFile(statePath, "utf8")));
			if (existing.opId !== descriptor.opId || existing.descriptorChecksum !== descriptor.checksum) {
				throw new Error("已存在 journal state 与 descriptor 不匹配");
			}
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
			await writeJsonAtomic(statePath, makeState(descriptor, "PREPARED", 1));
		}
	}

	async setPhase(opId: string, phase: JournalPhase, options: JournalPhaseOptions = {}): Promise<void> {
		const pending = await this.load(opId);
		if (!canTransition(pending.state.phase, phase)) {
			throw new Error(`journal phase 不能回退或跳跃：${pending.state.phase} -> ${phase}`);
		}
		const observedLogicalLeaf = options.observedLogicalLeaf === undefined
			? pending.state.observedLogicalLeaf
			: options.observedLogicalLeaf;
		await writeJsonAtomic(
			join(this.operationDirectory(opId), "state.json"),
			makeState(pending.descriptor, phase, pending.state.revision + 1, observedLogicalLeaf),
		);
	}

	async loadPending(): Promise<readonly PendingJournal[]> {
		let entries;
		try {
			entries = await readdir(this.transactionsRoot, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return [];
			throw error;
		}
		const result: PendingJournal[] = [];
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			try {
				const state = await lstat(join(this.transactionsRoot, entry.name, "state.json"));
				if (!state.isFile() || state.isSymbolicLink()) throw new Error("journal state 文件类型无效");
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) continue;
				throw error;
			}
			const journal = await this.load(entry.name);
			if (journal.state.phase !== "COMMITTED" && journal.state.phase !== "ABORTED") {
				result.push(journal);
			}
		}
		return result;
	}

	async markCommitted(opId: string): Promise<void> {
		await this.setPhase(opId, "COMMITTED");
	}

	/** 仅在恢复器已经重新验证 workspace 与 cursor 后，允许中间 phase 收敛到终态。 */
	async settleRecovery(opId: string, phase: "COMMITTED" | "ABORTED"): Promise<void> {
		const pending = await this.load(opId);
		if (pending.state.phase === phase) return;
		if (pending.state.phase === "COMMITTED" || pending.state.phase === "ABORTED") {
			throw new Error("journal 已处于不同终态");
		}
		await writeJsonAtomic(
			join(this.operationDirectory(opId), "state.json"),
			makeState(
				pending.descriptor,
				phase,
				pending.state.revision + 1,
				pending.state.observedLogicalLeaf,
			),
		);
	}

	async removeIfSettled(opId: string): Promise<void> {
		const pending = await this.load(opId);
		if (pending.state.phase !== "COMMITTED" && pending.state.phase !== "ABORTED") {
			return;
		}
		await rm(this.operationDirectory(opId), { recursive: true, force: true });
	}

	private async load(opId: string): Promise<PendingJournal> {
		const directory = this.operationDirectory(opId);
		const [descriptorBytes, planBytes, stateBytes] = await Promise.all([
			readFile(join(directory, "descriptor.json"), "utf8"),
			readFile(join(directory, "restore-plan.json"), "utf8"),
			readFile(join(directory, "state.json"), "utf8"),
		]);
		const descriptor = assertOperationDescriptor(JSON.parse(descriptorBytes));
		if (descriptor.opId !== opId) {
			throw new Error("journal directory 与 descriptor opId 不匹配");
		}
		const plan: unknown = JSON.parse(planBytes);
		if (!isPlanForDescriptor(plan, descriptor)) {
			throw new Error("journal restore plan 与 descriptor 不匹配");
		}
		const state = assertJournalState(JSON.parse(stateBytes));
		if (state.opId !== descriptor.opId || state.descriptorChecksum !== descriptor.checksum) {
			throw new Error("journal state 与 descriptor 不匹配");
		}
		return { descriptor, plan, state };
	}

	private operationDirectory(opId: string): string {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opId)) {
			throw new Error("journal opId 无效");
		}
		return join(this.transactionsRoot, opId);
	}
}

export async function inspectCursorMarkers(
	sessionFile: string,
	descriptor: OperationDescriptor,
): Promise<CursorMarkerInspection> {
	assertOperationDescriptor(descriptor);
	let content: string;
	try {
		content = await readFile(sessionFile, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "absent" };
		throw error;
	}
	const lines = content.split("\n");
	const finalLine = lines.length - 1;
	let matched: string | undefined;
	let needsTrailingNewline = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isCursorEntry(entry)) continue;
		const rawData = entry.data;
		const rawOpId = isRecord(rawData) && typeof rawData.opId === "string" ? rawData.opId : undefined;
		let cursor: CursorState;
		try {
			cursor = assertCursor(rawData);
		} catch {
			if (rawOpId === descriptor.opId) return { kind: "conflict" };
			continue;
		}
		if (cursor.opId !== descriptor.opId) continue;
		if (!matchesDescriptor(cursor, descriptor)) return { kind: "conflict" };
		const encoded = canonicalJson(cursor);
		if (matched !== undefined && matched !== encoded) return { kind: "conflict" };
		matched = encoded;
		needsTrailingNewline = index === finalLine && !content.endsWith("\n");
	}
	return matched === undefined ? { kind: "absent" } : { kind: "match", needsTrailingNewline };
}

export function decideRecovery(inspection: CursorMarkerInspection): RecoveryDecision {
	if (inspection.kind === "match") return { action: "roll_forward", reason: "durable_cursor" };
	if (inspection.kind === "absent") return { action: "rollback", reason: "cursor_absent" };
	return { action: "lock", reason: "cursor_conflict" };
}

export async function finalizeCursorMarker(
	sessionFile: string,
	descriptor: OperationDescriptor,
	inspection: Extract<CursorMarkerInspection, { kind: "match" }>,
): Promise<void> {
	if (inspection.needsTrailingNewline) {
		await appendFile(sessionFile, "\n");
	}
	await fsyncFile(sessionFile);
	await fsyncDirectory(dirname(sessionFile));
	const verified = await inspectCursorMarkers(sessionFile, descriptor);
	if (verified.kind !== "match" || verified.needsTrailingNewline) {
		throw new Error("cursor marker 耐久化校验失败");
	}
}

function makeState(
	descriptor: OperationDescriptor,
	phase: JournalPhase,
	revision: number,
	observedLogicalLeaf?: string | null,
): JournalState {
	const content = {
		schemaVersion: 1 as const,
		opId: descriptor.opId,
		phase,
		revision,
		descriptorChecksum: descriptor.checksum,
		...(observedLogicalLeaf === undefined ? {} : { observedLogicalLeaf }),
	};
	return { ...content, checksum: checksum(canonicalJson(content)) };
}

function canTransition(current: JournalPhase, next: JournalPhase): boolean {
	if (current === next || current === "COMMITTED" || current === "ABORTED") return false;
	if (next === "RECOVERY_REQUIRED") return true;
	if (next === "ABORTING") return current !== "ABORTING";
	if (next === "ABORTED") return current === "ABORTING";
	const order: JournalPhase[] = [
		"PREPARED", "SESSION_MOVED", "APPLYING", "FILES_VERIFIED", "CURSOR_COMMITTED", "COMMITTED",
	];
	return order.indexOf(next) === order.indexOf(current) + 1;
}

function matchesDescriptor(cursor: CursorState, descriptor: OperationDescriptor): boolean {
	return cursor.descriptorChecksum === descriptor.checksum &&
		cursor.action === descriptor.action &&
		cursor.targetManifestId === descriptor.targetManifestId &&
		cursor.rollbackManifestId === descriptor.rollbackManifestId &&
		cursor.sessionIdentity.path === descriptor.sessionIdentity.path &&
		cursor.sessionIdentity.headerChecksum === descriptor.sessionIdentity.headerChecksum;
}

function isPlanForDescriptor(value: unknown, descriptor: OperationDescriptor): boolean {
	return isRecord(value) && value.planDigest === descriptor.planDigest;
}

function isCursorEntry(value: unknown): value is { type: "custom"; customType: "pi-undo:cursor"; data: unknown } {
	return isRecord(value) && value.type === "custom" && value.customType === "pi-undo:cursor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
