import { resolve } from "node:path";

import type { CursorMarkerInspection, PendingJournal } from "./journal.ts";
import type { JournalPhase, ManifestId, SessionFileIdentity, SnapshotManifest } from "./model.ts";
import type { RestorePlan, RestoreResult } from "./restore-engine.ts";

export interface JournalRecoveryDependencies {
	readonly sessionIdentity: SessionFileIdentity;
	readonly workspaceIdentity: string;
	readonly getLogicalLeafId: () => string | null;
	readonly loadPending: () => Promise<readonly PendingJournal[]>;
	readonly inspectCursor: (journal: PendingJournal) => Promise<CursorMarkerInspection>;
	readonly finalizeCursor: (journal: PendingJournal, inspection: Extract<CursorMarkerInspection, { kind: "match" }>) => Promise<void>;
	readonly recoverMutations: (
		journal: PendingJournal,
		decision: "rollback" | "roll_forward",
	) => Promise<{ readonly kind: "clean" } | { readonly kind: "conflict"; readonly paths: number }>;
	readonly capture: () => Promise<SnapshotManifest>;
	readonly loadManifest: (id: ManifestId) => Promise<SnapshotManifest>;
	readonly planRestore: (
		current: SnapshotManifest,
		target: SnapshotManifest,
		scopePaths?: readonly string[],
	) => Promise<RestorePlan>;
	readonly applyRestore: (
		plan: RestorePlan,
		target: SnapshotManifest,
		operation: { readonly opId: string },
	) => Promise<RestoreResult>;
	readonly settle: (opId: string, phase: Extract<JournalPhase, "COMMITTED" | "ABORTED">) => Promise<void>;
}

export type JournalRecoveryResult =
	| { readonly kind: "clean"; readonly operations: 0 }
	| { readonly kind: "recovered"; readonly operations: number }
	| {
		readonly kind: "locked";
		readonly reason: string;
		readonly operations: number;
		readonly files?: number;
		readonly opId?: string;
	};

/**
 * 根据 durable cursor marker 决定向前补完或回滚。
 * 恢复操作是 set-state 且可重复执行；任何身份或 leaf 证据不一致都 fail closed。
 */
export class JournalRecovery {
	private readonly dependencies: JournalRecoveryDependencies;

	constructor(dependencies: JournalRecoveryDependencies) {
		this.dependencies = dependencies;
	}

	async recover(): Promise<JournalRecoveryResult> {
		let recovered = 0;
		let pending: readonly PendingJournal[];
		try {
			pending = await this.dependencies.loadPending();
		} catch {
			return { kind: "locked", reason: "journal_invalid", operations: recovered };
		}
		if (pending.length === 0) return { kind: "clean", operations: 0 };

		for (const journal of pending) {
			const identityError = this.identityError(journal);
			if (identityError !== null) {
				return { kind: "locked", reason: identityError, operations: recovered };
			}
			let inspection: CursorMarkerInspection;
			try {
				inspection = await this.dependencies.inspectCursor(journal);
			} catch {
				return { kind: "locked", reason: "cursor_inspection_failed", operations: recovered };
			}
			if (inspection.kind === "conflict") {
				return { kind: "locked", reason: "cursor_conflict", operations: recovered };
			}
			const expectedLeaf = inspection.kind === "match"
				? journal.descriptor.toLogicalLeaf
				: journal.descriptor.fromLogicalLeaf;
			if (this.dependencies.getLogicalLeafId() !== expectedLeaf) {
				return { kind: "locked", reason: "session_leaf_mismatch", operations: recovered };
			}
			const mutationDecision = inspection.kind === "match" ? "roll_forward" : "rollback";
			let mutationResult: Awaited<ReturnType<JournalRecoveryDependencies["recoverMutations"]>>;
			try {
				mutationResult = await this.dependencies.recoverMutations(journal, mutationDecision);
			} catch {
				return { kind: "locked", reason: "mutation_recovery_failed", operations: recovered };
			}
			if (mutationResult.kind === "conflict") {
				return {
					kind: "locked",
					reason: "mutation_conflict",
					operations: recovered,
					files: mutationResult.paths,
					opId: journal.descriptor.opId,
				};
			}

			try {
				const current = await this.dependencies.capture();
				const targetId = inspection.kind === "match"
					? journal.descriptor.targetManifestId
					: journal.descriptor.rollbackManifestId;
				const target = await this.dependencies.loadManifest(targetId);
				const plan = await this.dependencies.planRestore(current, target, journal.descriptor.scopePaths);
				const applied = await this.dependencies.applyRestore(
					plan,
					target,
					{ opId: journal.descriptor.opId },
				);
				if (applied.code !== "ok") {
					return { kind: "locked", reason: "restore_failed", operations: recovered };
				}
				if (inspection.kind === "match") {
					await this.dependencies.finalizeCursor(journal, inspection);
				}
				await this.dependencies.settle(
					journal.descriptor.opId,
					inspection.kind === "match" ? "COMMITTED" : "ABORTED",
				);
				recovered += 1;
			} catch {
				return { kind: "locked", reason: "recovery_failed", operations: recovered };
			}
		}
		return { kind: "recovered", operations: recovered };
	}

	private identityError(journal: PendingJournal): string | null {
		if (journal.descriptor.workspaceIdentity !== this.dependencies.workspaceIdentity) {
			return "workspace_identity_mismatch";
		}
		const observed = journal.descriptor.sessionIdentity;
		const expected = this.dependencies.sessionIdentity;
		if (resolve(observed.path) !== resolve(expected.path) || observed.headerChecksum !== expected.headerChecksum) {
			return "session_identity_mismatch";
		}
		return null;
	}
}
