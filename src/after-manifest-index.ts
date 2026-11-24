import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-fs.ts";
import { canonicalJson, checksum } from "./encoding.ts";
import type { CheckpointRecord, ManifestId, SnapshotManifest } from "./model.ts";
import { rethrowOperationFailure } from "./operation-context.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

/** 完整 after 独立落盘，不在后台改变当前会话的物理分支。 */
export class AfterManifestIndex {
	constructor(private readonly privateRoot: string, private readonly store: SnapshotStore) {}

	private path(checkpoint: CheckpointRecord): string {
		const identity = checksum(canonicalJson(checkpoint.sessionIdentity));
		return join(this.privateRoot, "checkpoint-after", identity, `${checksum(checkpoint.checksum)}.json`);
	}

	async save(checkpoint: CheckpointRecord, after: SnapshotManifest): Promise<void> {
		if (after.coverage !== "complete") throw new Error("物化索引只接受完整 after");
		const payload = {
			schemaVersion: 1,
			checkpointChecksum: checkpoint.checksum,
			beforeManifestId: checkpoint.beforeManifestId,
			afterManifestId: after.manifestId,
		};
		await writeJsonAtomic(this.path(checkpoint), { ...payload, checksum: checksum(canonicalJson(payload)) });
	}

	async load(checkpoint: CheckpointRecord): Promise<ManifestId | undefined> {
		try {
			const value = JSON.parse(await readFile(this.path(checkpoint), "utf8"));
			if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
			const { checksum: digest, ...payload } = value;
			if (payload.schemaVersion !== 1 || payload.checkpointChecksum !== checkpoint.checksum ||
				payload.beforeManifestId !== checkpoint.beforeManifestId ||
				typeof payload.afterManifestId !== "string" || !/^[a-f0-9]{64}$/.test(payload.afterManifestId) ||
				digest !== checksum(canonicalJson(payload))) return undefined;
			const after = await this.store.loadManifest(payload.afterManifestId as ManifestId);
			const before = await this.store.loadManifest(checkpoint.beforeManifestId);
			if (after.coverage !== "complete" || after.workspaceIdentity !== before.workspaceIdentity) return undefined;
			return after.manifestId;
		} catch (error) {
			rethrowOperationFailure(error);
			// 索引丢失或损坏不能把 pending 冒充成完整历史。
			return undefined;
		}
	}
}
