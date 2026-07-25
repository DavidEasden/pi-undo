import { appendFile, lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fsyncDirectory, fsyncFile } from "./atomic-fs.ts";
import { assertCursor, canonicalJson, checksum } from "./encoding.ts";
import type { CheckpointRecord, CursorState, ManifestId, SessionFileIdentity } from "./model.ts";

export interface SessionEntry {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly customType?: string;
	readonly data?: unknown;
}

export interface SessionEntrySource {
	getEntries(): readonly unknown[];
	getLeafId(): string | null;
	getSessionFile(): string | undefined;
}

export interface CursorEntryAppender {
	appendEntry(customType: string, data?: unknown): void | Promise<void>;
}

export type DurableCursorResult =
	| { readonly kind: "durable"; readonly logicalLeafId: string | null }
	| { readonly kind: "volatile"; readonly reason: "session_file_unavailable" }
	| { readonly kind: "recovery_required"; readonly reason: "append_ambiguous" | "cursor_missing" | "cursor_conflict" | "session_identity_mismatch" };

export class SessionState {
	private readonly source: SessionEntrySource;

	constructor(source: SessionEntrySource) {
		this.source = source;
	}

	getActiveBranch(): readonly SessionEntry[] {
		return this.physicalBranch().filter((entry) => !isUndoControlEntry(entry));
	}

	/**
	 * 只投影属于已核验 session identity 的可信 checkpoint。
	 *
	 * 损坏、半截、旧会话或链路不完整的记录会被安全排除，而不是进入 undo 栈；
	 * 调用方必须传入由 getSessionIdentity() 读取并核验的当前 identity。
	 */
	getCheckpoints(sessionIdentity: SessionFileIdentity): readonly CheckpointRecord[] {
		assertSessionFileIdentity(sessionIdentity);
		const branch = this.physicalBranch();
		const positions = new Map(branch.map((entry, index) => [entry.id, index]));
		const entries = new Map(branch.map((entry) => [entry.id, entry]));
		const candidates: CheckpointRecord[] = [];
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== "pi-undo:checkpoint") continue;
			try {
				const checkpoint = checkpointFromEntry(entry, sessionIdentity);
				if (isCheckpointChainTrusted(checkpoint, entry.id, positions, entries)) candidates.push(checkpoint);
			} catch {
				// Session 历史是外部持久化输入；无效 checkpoint 只能被排除。
			}
		}
		const counts = new Map<string, number>();
		for (const checkpoint of candidates) {
			counts.set(checkpoint.checkpointId, (counts.get(checkpoint.checkpointId) ?? 0) + 1);
		}
		return candidates.filter((checkpoint) => counts.get(checkpoint.checkpointId) === 1);
	}

	async getSessionIdentity(): Promise<SessionFileIdentity | null> {
		const sessionFile = this.source.getSessionFile();
		if (sessionFile === undefined) return null;
		return readSessionFileIdentity(sessionFile);
	}

	getCursor(sessionIdentity: SessionFileIdentity): CursorState | null {
		for (const entry of [...this.physicalBranch()].reverse()) {
			if (entry.type !== "custom") continue;
			if (
				entry.customType === "pi-undo:start" ||
				entry.customType === "pi-undo:checkpoint" ||
				entry.customType === "pi-undo:barrier"
			) return null;
			if (entry.customType !== "pi-undo:cursor") continue;
			const cursor = assertCursor(entry.data);
			return sameSessionIdentity(cursor.sessionIdentity, sessionIdentity) ? cursor : null;
		}
		return null;
	}

	verifyCursorOnCurrentBranch(expected: CursorState): "match" | "absent" | "conflict" {
		const entries = this.entryIndex();
		const matches: SessionEntry[] = [];
		for (const entry of this.physicalBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-undo:cursor") continue;
			const rawOpId = isRecord(entry.data) && typeof entry.data.opId === "string" ? entry.data.opId : undefined;
			let cursor: CursorState;
			try {
				cursor = assertCursor(entry.data);
			} catch {
				if (rawOpId === expected.opId) return "conflict";
				continue;
			}
			if (cursor.opId !== expected.opId) continue;
			if (cursor.checksum !== expected.checksum || canonicalJson(cursor) !== canonicalJson(expected)) return "conflict";
			matches.push(entry);
		}
		if (matches.length === 0) return "absent";
		if (matches.length !== 1) return "conflict";
		return this.logicalLeafFrom(entries, matches[0]!.parentId) === expected.toLogicalLeaf ? "match" : "conflict";
	}

	getLogicalLeafId(): string | null {
		const entries = this.entryIndex();
		let current = this.source.getLeafId();
		const visited = new Set<string>();
		while (current !== null) {
			if (visited.has(current)) throw new Error("session parent cycle");
			visited.add(current);
			const entry = entries.get(current);
			if (entry === undefined) throw new Error("session leaf parent 缺失");
			if (!isUndoControlEntry(entry)) return entry.id;
			current = entry.parentId;
		}
		return null;
	}

	findUserEntry(checkpointId: string, sessionIdentity: SessionFileIdentity): string {
		const checkpoint = this.getCheckpoints(sessionIdentity).find((candidate) => candidate.checkpointId === checkpointId);
		if (checkpoint === undefined) throw new Error("checkpoint 不在 active branch");
		return checkpoint.userEntryId;
	}

	async findTargetManifest(targetId: string, sessionIdentity: SessionFileIdentity): Promise<ManifestId> {
		const checkpoint = this.getCheckpoints(sessionIdentity).find((candidate) => candidate.checkpointId === targetId);
		if (checkpoint === undefined) throw new Error("checkpoint 不在 active branch");
		return checkpoint.afterManifestId;
	}

	private physicalBranch(): readonly SessionEntry[] {
		const entries = this.entryIndex();
		const result: SessionEntry[] = [];
		let current = this.source.getLeafId();
		const visited = new Set<string>();
		while (current !== null) {
			if (visited.has(current)) throw new Error("session parent cycle");
			visited.add(current);
			const entry = entries.get(current);
			if (entry === undefined) throw new Error("session parent 缺失");
			result.push(entry);
			current = entry.parentId;
		}
		return result.reverse();
	}

	private entryIndex(): Map<string, SessionEntry> {
		const entries = new Map<string, SessionEntry>();
		for (const value of this.source.getEntries()) {
			const entry = assertSessionEntry(value);
			if (entries.has(entry.id)) throw new Error("session entry ID 重复");
			entries.set(entry.id, entry);
		}
		return entries;
	}

	private logicalLeafFrom(entries: ReadonlyMap<string, SessionEntry>, start: string | null): string | null {
		let current = start;
		const visited = new Set<string>();
		while (current !== null) {
			if (visited.has(current)) throw new Error("session parent cycle");
			visited.add(current);
			const entry = entries.get(current);
			if (entry === undefined) throw new Error("session parent 缺失");
			if (!isUndoControlEntry(entry)) return entry.id;
			current = entry.parentId;
		}
		return null;
	}
}

export class DurableCursorWriter {
	async appendCursor(
		state: CursorState,
		pi: CursorEntryAppender,
		session: SessionEntrySource,
	): Promise<DurableCursorResult> {
		assertCursor(state);
		const sessionFile = session.getSessionFile();
		if (sessionFile === undefined || !await isRegularFile(sessionFile)) {
			return { kind: "volatile", reason: "session_file_unavailable" };
		}
		if (!await sessionIdentityMatches(sessionFile, state.sessionIdentity)) {
			return { kind: "recovery_required", reason: "session_identity_mismatch" };
		}
		try {
			await pi.appendEntry("pi-undo:cursor", state);
		} catch {
			const inspection = await inspectCursorState(sessionFile, state);
			return inspection.kind === "match"
				? this.finishDurable(sessionFile, state, session, inspection.needsTrailingNewline)
				: { kind: "recovery_required", reason: "append_ambiguous" };
		}
		const inspection = await inspectCursorState(sessionFile, state);
		if (inspection.kind === "conflict") return { kind: "recovery_required", reason: "cursor_conflict" };
		if (inspection.kind === "absent") return { kind: "recovery_required", reason: "cursor_missing" };
		return this.finishDurable(sessionFile, state, session, inspection.needsTrailingNewline);
	}

	private async finishDurable(
		sessionFile: string,
		state: CursorState,
		session: SessionEntrySource,
		needsTrailingNewline: boolean,
	): Promise<DurableCursorResult> {
		if (needsTrailingNewline) {
			await appendFile(sessionFile, "\n");
		}
		await fsyncFile(sessionFile);
		await fsyncDirectory(dirname(sessionFile));
		if (!await sessionIdentityMatches(sessionFile, state.sessionIdentity)) {
			return { kind: "recovery_required", reason: "session_identity_mismatch" };
		}
		const verification = await inspectCursorState(sessionFile, state);
		if (verification.kind !== "match") return { kind: "recovery_required", reason: "cursor_conflict" };
		const branch = new SessionState(session).verifyCursorOnCurrentBranch(state);
		if (branch === "absent") return { kind: "recovery_required", reason: "cursor_missing" };
		if (branch === "conflict") return { kind: "recovery_required", reason: "cursor_conflict" };
		return { kind: "durable", logicalLeafId: new SessionState(session).getLogicalLeafId() };
	}
}

type CursorInspection =
	| { readonly kind: "absent" }
	| { readonly kind: "match"; readonly needsTrailingNewline: boolean }
	| { readonly kind: "conflict" };

async function inspectCursorState(sessionFile: string, expected: CursorState): Promise<CursorInspection> {
	const content = await readFile(sessionFile, "utf8");
	const lines = content.split("\n");
	let found: string | undefined;
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
		const rawOpId = isRecord(entry.data) && typeof entry.data.opId === "string" ? entry.data.opId : undefined;
		let candidate: CursorState;
		try {
			candidate = assertCursor(entry.data);
		} catch {
			if (rawOpId === expected.opId) return { kind: "conflict" };
			continue;
		}
		if (candidate.opId !== expected.opId) continue;
		const encoded = canonicalJson(candidate);
		if (encoded !== canonicalJson(expected)) return { kind: "conflict" };
		if (found !== undefined && found !== encoded) return { kind: "conflict" };
		found = encoded;
		needsTrailingNewline = index === lines.length - 1 && !content.endsWith("\n");
	}
	return found === undefined ? { kind: "absent" } : { kind: "match", needsTrailingNewline };
}

async function sessionIdentityMatches(sessionFile: string, identity: SessionFileIdentity): Promise<boolean> {
	const observed = await readSessionFileIdentity(sessionFile);
	return observed !== null && sameSessionIdentity(observed, identity);
}

async function readSessionFileIdentity(sessionFile: string): Promise<SessionFileIdentity | null> {
	if (!await isRegularFile(sessionFile)) return null;
	const content = await readFile(sessionFile, "utf8");
	const firstLine = content.split("\n")[0];
	if (firstLine === undefined || firstLine.length === 0) return null;
	try {
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string" || typeof header.cwd !== "string") {
			return null;
		}
		return {
			path: resolve(sessionFile),
			headerChecksum: checksum(canonicalJson({ id: header.id, timestamp: header.timestamp, cwd: header.cwd })),
		};
	} catch {
		return null;
	}
}

function sameSessionIdentity(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
	return resolve(left.path) === resolve(right.path) && left.headerChecksum === right.headerChecksum;
}

async function isRegularFile(path: string): Promise<boolean> {
	try {
		const metadata = await lstat(path);
		return metadata.isFile() && !metadata.isSymbolicLink();
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

function assertSessionEntry(value: unknown): SessionEntry {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string" || value.id.length === 0 ||
		(value.parentId !== null && typeof value.parentId !== "string")) {
		throw new Error("session entry 无效");
	}
	if (value.customType !== undefined && typeof value.customType !== "string") {
		throw new Error("session customType 无效");
	}
	return value as unknown as SessionEntry;
}

function checkpointFromEntry(entry: SessionEntry, expectedIdentity: SessionFileIdentity): CheckpointRecord {
	if (!isRecord(entry.data) || !hasOnlyEnumerableDataProperties(entry.data)) {
		throw new Error("checkpoint entry 无效");
	}
	const record = entry.data;
	const fields = [
		"afterManifestId", "beforeManifestId", "changedPaths", "checkpointId", "checksum", "endLeafId",
		"rawPrompt", "runId", "schemaVersion", "sessionIdentity", "startEntryId", "userEntryId",
	];
	if (Object.keys(record).sort().join("\0") !== fields.join("\0") || record.schemaVersion !== 1 ||
		!isEntryId(record.checkpointId) || !isEntryId(record.runId) || !isEntryId(record.startEntryId) ||
		!isEntryId(record.userEntryId) || !isEntryId(record.endLeafId) || typeof record.rawPrompt !== "string" ||
		!isManifestId(record.beforeManifestId) || !isManifestId(record.afterManifestId) ||
		!isCanonicalChangedPaths(record.changedPaths) || !isChecksum(record.checksum)) {
		throw new Error("checkpoint entry 无效");
	}
	assertSessionFileIdentity(record.sessionIdentity);
	if (!sameSessionIdentity(record.sessionIdentity, expectedIdentity)) {
		throw new Error("checkpoint session identity 不匹配");
	}
	const { checksum: recordChecksum, ...content } = record;
	if (recordChecksum !== checksum(canonicalJson(content))) {
		throw new Error("checkpoint checksum 不匹配");
	}
	return record as unknown as CheckpointRecord;
}

function isCheckpointChainTrusted(
	checkpoint: CheckpointRecord,
	checkpointEntryId: string,
	positions: ReadonlyMap<string, number>,
	entries: ReadonlyMap<string, SessionEntry>,
): boolean {
	const start = positions.get(checkpoint.startEntryId);
	const user = positions.get(checkpoint.userEntryId);
	const end = positions.get(checkpoint.endLeafId);
	const checkpointEntry = positions.get(checkpointEntryId);
	const startEntry = entries.get(checkpoint.startEntryId);
	const userEntry = entries.get(checkpoint.userEntryId);
	const endEntry = entries.get(checkpoint.endLeafId);
	const checkpointRecord = entries.get(checkpointEntryId);
	return start !== undefined && user !== undefined && end !== undefined && checkpointEntry !== undefined &&
		start < user && user <= end && end < checkpointEntry &&
		startEntry?.type === "custom" && startEntry.customType === "pi-undo:start" &&
		userEntry?.parentId === checkpoint.startEntryId && isMessageRole(userEntry, "user") &&
		endEntry !== undefined && !isUndoControlEntry(endEntry) && checkpointRecord !== undefined &&
		logicalLeafFrom(entries, checkpointRecord.parentId) === checkpoint.endLeafId;
}

function logicalLeafFrom(entries: ReadonlyMap<string, SessionEntry>, start: string | null): string | null {
	let current = start;
	const visited = new Set<string>();
	while (current !== null) {
		if (visited.has(current)) throw new Error("session parent cycle");
		visited.add(current);
		const entry = entries.get(current);
		if (entry === undefined) throw new Error("session parent 缺失");
		if (!isUndoControlEntry(entry)) return entry.id;
		current = entry.parentId;
	}
	return null;
}

function isMessageRole(entry: SessionEntry, role: string): boolean {
	return entry.type === "message" && isRecord(entry) && isRecord(entry.message) && entry.message.role === role;
}

function assertSessionFileIdentity(value: unknown): asserts value is SessionFileIdentity {
	if (!isRecord(value) || !hasOnlyEnumerableDataProperties(value) || Object.keys(value).sort().join("\0") !== "headerChecksum\0path" ||
		typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\0") || !isChecksum(value.headerChecksum)) {
		throw new Error("session identity 无效");
	}
}

function isEntryId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isManifestId(value: unknown): value is ManifestId {
	return isChecksum(value);
}

function isChecksum(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalChangedPaths(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) return false;
	let previous: string | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const path = value[index];
		if (!Object.prototype.hasOwnProperty.call(value, index) || typeof path !== "string" || !isCanonicalRelativePath(path) ||
			(previous !== undefined && previous >= path)) return false;
		previous = path;
	}
	return true;
}

function isCanonicalRelativePath(path: string): boolean {
	if (path === ".") return true;
	if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) {
		return false;
	}
	return path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function hasOnlyEnumerableDataProperties(value: object): boolean {
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length > 0) {
		return false;
	}
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(descriptor) => descriptor.enumerable && Object.hasOwn(descriptor, "value"),
	);
}

function isUndoControlEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType?.startsWith("pi-undo:") === true;
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
