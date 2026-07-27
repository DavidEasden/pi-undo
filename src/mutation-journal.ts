import { open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { fsyncDirectory } from "./atomic-fs.ts";
import { assertMutationRecord, assertOperationId, canonicalJson, checksum } from "./encoding.ts";
import type { MutationRecord, MutationState } from "./model.ts";

export interface MutationIntent {
	readonly kind: MutationRecord["kind"];
	readonly path: string;
	readonly sourceArtifact: string;
	readonly targetArtifact: string | null;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
}

interface JournalRecords {
	readonly latest: readonly MutationRecord[];
	readonly tail: MutationRecord | undefined;
	readonly durableEnd: number;
	readonly hasNonDurableTail: boolean;
	readonly fileExisted: boolean;
}

interface CachedJournalRecords {
	readonly records: JournalRecords;
	readonly fingerprint: string;
}

const stateOrder: readonly MutationState[] = [
	"INTENT",
	"SOURCE_QUARANTINED",
	"SOURCE_VERIFIED",
	"TARGET_INSTALLED",
	"TARGET_VERIFIED",
	"CLEANED",
];

export class MutationJournal {
	private readonly path: string;
	private readonly opId: string;
	private mutationQueue: Promise<void> = Promise.resolve();
	private cachedRecords: CachedJournalRecords | undefined;

	constructor(path: string, opId: string) {
		this.path = path;
		this.opId = assertOperationId(opId);
	}

	get operationId(): string {
		return this.opId;
	}

	get storagePath(): string {
		return this.path;
	}

	async load(): Promise<readonly MutationRecord[]> {
		return (await this.readRecords()).latest;
	}

	begin(intent: MutationIntent): Promise<MutationRecord> {
		return this.enqueueMutation(() => this.beginMutation(intent));
	}

	private async beginMutation(intent: MutationIntent): Promise<MutationRecord> {
		const current = await this.readRecords();
		const content = {
			schemaVersion: 1 as const,
			opId: this.opId,
			ordinal: current.latest.length + 1,
			state: "INTENT" as const,
			kind: intent.kind,
			path: intent.path,
			sourceArtifact: intent.sourceArtifact,
			targetArtifact: intent.targetArtifact,
			sourceFingerprint: intent.sourceFingerprint,
			targetFingerprint: intent.targetFingerprint,
			previousChecksum: current.tail?.checksum ?? null,
		};
		const record = assertMutationRecord({ ...content, checksum: checksum(canonicalJson(content)) });
		await this.append([record], current);
		return record;
	}

	advance(ordinal: number, state: MutationState): Promise<MutationRecord> {
		return this.enqueueMutation(() => this.advanceMutation(ordinal, state));
	}

	advanceMany(ordinal: number, states: readonly MutationState[]): Promise<readonly MutationRecord[]> {
		return this.enqueueMutation(() => this.advanceManyMutation(ordinal, states));
	}

	markRollbackCleaned(ordinal: number): Promise<MutationRecord> {
		return this.enqueueMutation(() => this.markRollbackCleanedMutation(ordinal));
	}

	private async markRollbackCleanedMutation(ordinal: number): Promise<MutationRecord> {
		const current = await this.readRecords();
		const previous = current.latest[ordinal - 1];
		if (previous === undefined || previous.state === "CLEANED") {
			throw new Error(`mutation rollback 终结状态无效：${previous?.state ?? "missing"}`);
		}
		return this.appendState(current, previous, "CLEANED");
	}

	private async advanceMutation(ordinal: number, state: MutationState): Promise<MutationRecord> {
		const [record] = await this.advanceManyMutation(ordinal, [state]);
		return record!;
	}

	private async advanceManyMutation(
		ordinal: number,
		states: readonly MutationState[],
	): Promise<readonly MutationRecord[]> {
		if (states.length === 0) throw new Error("mutation 批量状态不能为空");
		const current = await this.readRecords();
		const latest = [...current.latest];
		let tail = current.tail;
		const records: MutationRecord[] = [];
		for (const state of states) {
			const previous = latest[ordinal - 1];
			if (previous === undefined || stateOrder.indexOf(state) !== stateOrder.indexOf(previous.state) + 1) {
				throw new Error(`mutation state 必须严格推进：${previous?.state ?? "missing"} -> ${state}`);
			}
			const content = {
				schemaVersion: previous.schemaVersion,
				opId: previous.opId,
				ordinal: previous.ordinal,
				state,
				kind: previous.kind,
				path: previous.path,
				sourceArtifact: previous.sourceArtifact,
				targetArtifact: previous.targetArtifact,
				sourceFingerprint: previous.sourceFingerprint,
				targetFingerprint: previous.targetFingerprint,
				previousChecksum: tail?.checksum ?? null,
			};
			const record = assertMutationRecord({ ...content, checksum: checksum(canonicalJson(content)) });
			records.push(record);
			latest[ordinal - 1] = record;
			tail = record;
		}
		await this.append(records, current);
		return records;
	}

	private async appendState(
		current: JournalRecords,
		previous: MutationRecord,
		state: MutationState,
	): Promise<MutationRecord> {
		const content = {
			schemaVersion: previous.schemaVersion,
			opId: previous.opId,
			ordinal: previous.ordinal,
			state,
			kind: previous.kind,
			path: previous.path,
			sourceArtifact: previous.sourceArtifact,
			targetArtifact: previous.targetArtifact,
			sourceFingerprint: previous.sourceFingerprint,
			targetFingerprint: previous.targetFingerprint,
			previousChecksum: current.tail?.checksum ?? null,
		};
		const record = assertMutationRecord({ ...content, checksum: checksum(canonicalJson(content)) });
		await this.append([record], current);
		return record;
	}

	private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation);
		this.mutationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async activeArtifacts(): Promise<ReadonlySet<string>> {
		const artifacts = new Set<string>();
		for (const record of await this.load()) {
			if (record.state === "CLEANED") continue;
			artifacts.add(record.sourceArtifact);
			if (record.targetArtifact !== null) artifacts.add(record.targetArtifact);
		}
		return artifacts;
	}

	async assertCleaned(): Promise<void> {
		if ((await this.load()).some((record) => record.state !== "CLEANED")) {
			throw new Error("mutation journal 仍有未清理 artifact");
		}
	}

	private async readRecords(): Promise<JournalRecords> {
		const before = await journalFileFingerprint(this.path);
		if (before !== null && this.cachedRecords?.fingerprint === before) {
			return this.cachedRecords.records;
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(this.path);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				const records = emptyJournalRecords();
				this.cachedRecords = undefined;
				return records;
			}
			throw error;
		}
		const after = await journalFileFingerprint(this.path);
		if (before === null || after === null || before !== after) {
			throw new Error("mutation journal 读取期间发生变化");
		}

		const durableEnd = bytes.at(-1) === 0x0a ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
		const durable = bytes.subarray(0, durableEnd).toString("utf8");
		const lines = durable === "" ? [] : durable.slice(0, -1).split("\n");
		const latest: MutationRecord[] = [];
		let tail: MutationRecord | undefined;

		for (const line of lines) {
			const record = Object.freeze(assertMutationRecord(JSON.parse(line)));
			if (record.opId !== this.opId) throw new Error("mutation record opId 与 journal 不匹配");
			if (record.previousChecksum !== (tail?.checksum ?? null)) {
				throw new Error("mutation journal hash chain 断裂");
			}

			const previous = latest[record.ordinal - 1];
			if (previous === undefined) {
				if (record.ordinal !== latest.length + 1) throw new Error("mutation ordinal 不连续");
				if (record.state !== "INTENT") throw new Error("mutation ordinal 必须从 INTENT 开始");
			} else {
				if (immutablePayload(previous) !== immutablePayload(record)) {
					throw new Error("同一 mutation ordinal 的 immutable payload 冲突");
				}
				if (!isValidDurableTransition(previous.state, record.state)) {
					throw new Error("mutation state 未严格推进");
				}
			}
			latest[record.ordinal - 1] = record;
			tail = record;
		}

		const records: JournalRecords = {
			latest: Object.freeze(latest),
			tail,
			durableEnd,
			hasNonDurableTail: durableEnd !== bytes.length,
			fileExisted: true,
		};
		this.cachedRecords = { records, fingerprint: after };
		return records;
	}

	private async append(records: readonly MutationRecord[], current: JournalRecords): Promise<void> {
		const directory = dirname(this.path);
		const lines = records.map((record) => `${canonicalJson(record)}\n`).join("");
		const handle = await open(this.path, "a+", 0o600);
		try {
			if (current.hasNonDurableTail) {
				await handle.truncate(current.durableEnd);
				await handle.sync();
			}
			await handle.writeFile(lines);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!current.fileExisted) await fsyncDirectory(directory);
		const fingerprint = await journalFileFingerprint(this.path);
		if (fingerprint === null) throw new Error("mutation journal append 后丢失");
		const latest = [...current.latest];
		let tail = current.tail;
		for (const record of records) {
			const durableRecord = Object.freeze({ ...record });
			latest[record.ordinal - 1] = durableRecord;
			tail = durableRecord;
		}
		this.cachedRecords = {
			records: {
				latest: Object.freeze(latest),
				tail,
				durableEnd: current.durableEnd + Buffer.byteLength(lines),
				hasNonDurableTail: false,
				fileExisted: true,
			},
			fingerprint,
		};
	}
}

function emptyJournalRecords(): JournalRecords {
	return {
		latest: Object.freeze([]),
		tail: undefined,
		durableEnd: 0,
		hasNonDurableTail: false,
		fileExisted: false,
	};
}

async function journalFileFingerprint(path: string): Promise<string | null> {
	try {
		const metadata = await stat(path, { bigint: true });
		return [
			metadata.dev,
			metadata.ino,
			metadata.mode,
			metadata.size,
			metadata.mtimeNs,
			metadata.ctimeNs,
		].join(":");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

function isValidDurableTransition(previous: MutationState, next: MutationState): boolean {
	return stateOrder.indexOf(next) === stateOrder.indexOf(previous) + 1 ||
		(next === "CLEANED" && previous !== "CLEANED");
}

function immutablePayload(record: MutationRecord): string {
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

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
