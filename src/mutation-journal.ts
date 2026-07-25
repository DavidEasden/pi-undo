import { open, readFile } from "node:fs/promises";
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

	constructor(path: string, opId: string) {
		this.path = path;
		this.opId = assertOperationId(opId);
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
		await this.append(record, current.durableEnd, current.hasNonDurableTail);
		return record;
	}

	advance(ordinal: number, state: MutationState): Promise<MutationRecord> {
		return this.enqueueMutation(() => this.advanceMutation(ordinal, state));
	}

	private async advanceMutation(ordinal: number, state: MutationState): Promise<MutationRecord> {
		const current = await this.readRecords();
		const previous = current.latest[ordinal - 1];
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
			previousChecksum: current.tail?.checksum ?? null,
		};
		const record = assertMutationRecord({ ...content, checksum: checksum(canonicalJson(content)) });
		await this.append(record, current.durableEnd, current.hasNonDurableTail);
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

	private async readRecords(): Promise<{
		readonly latest: readonly MutationRecord[];
		readonly tail: MutationRecord | undefined;
		readonly durableEnd: number;
		readonly hasNonDurableTail: boolean;
	}> {
		let bytes: Buffer;
		try {
			bytes = await readFile(this.path);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return { latest: [], tail: undefined, durableEnd: 0, hasNonDurableTail: false };
			}
			throw error;
		}

		const durableEnd = bytes.at(-1) === 0x0a ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
		const durable = bytes.subarray(0, durableEnd).toString("utf8");
		const lines = durable === "" ? [] : durable.slice(0, -1).split("\n");
		const latest: MutationRecord[] = [];
		let tail: MutationRecord | undefined;

		for (const line of lines) {
			const record = assertMutationRecord(JSON.parse(line));
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
				if (stateOrder.indexOf(record.state) !== stateOrder.indexOf(previous.state) + 1) {
					throw new Error("mutation state 未严格推进");
				}
			}
			latest[record.ordinal - 1] = record;
			tail = record;
		}

		return { latest, tail, durableEnd, hasNonDurableTail: durableEnd !== bytes.length };
	}

	private async append(record: MutationRecord, durableEnd: number, hasNonDurableTail: boolean): Promise<void> {
		const directory = dirname(this.path);
		const handle = await open(this.path, "a+", 0o600);
		try {
			if (hasNonDurableTail) {
				await handle.truncate(durableEnd);
				await handle.sync();
				await fsyncDirectory(directory);
			}
			await handle.writeFile(`${canonicalJson(record)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fsyncDirectory(directory);
	}
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
