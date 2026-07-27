import { join, resolve } from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ReadonlySessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	UndoControllerImpl,
	type ControllerDependencies,
	type ControllerInitialState,
} from "./controller.ts";
import { finalizeDurablePack, hasDurablePack, loadDurablePack } from "./durable-pack.ts";
import { assertCursor, canonicalJson, checksum } from "./encoding.ts";
import { JournalStore, finalizeCursorMarker, inspectCursorMarkers } from "./journal.ts";
import type { CheckpointRecord, ManifestId, SessionFileIdentity } from "./model.ts";
import { cleanupPackedMutations, recoverPackedMutations } from "./packed-recovery.ts";
import { JournalRecovery } from "./recovery.ts";
import { QuarantineManager } from "./quarantine.ts";
import { RestoreEngine } from "./restore-engine.ts";
import { RootDiscovery } from "./root-discovery.ts";
import { DurableCursorWriter, SessionState, type SessionEntrySource } from "./session-state.ts";
import { SnapshotStore } from "./snapshot-store.ts";
import { StatusReporter } from "./status-reporter.ts";
import { WorkspaceLock } from "./workspace-lock.ts";

export async function createPiUndoRuntime(context: ExtensionContext, pi: ExtensionAPI) {
	const manager = context.sessionManager;
	const sessionState = sessionStateFor(manager);
	const sessionIdentity = await sessionState.getSessionIdentity() ?? volatileSessionIdentity(manager, context.cwd);
	const privateRoot = join(manager.getSessionDir(), ".pi-undo");
	const discovery = new RootDiscovery();
	const initialTopology = await discovery.discover(context.cwd);
	const store = new SnapshotStore({ storeRoot: privateRoot, discovery });
	const restore = new RestoreEngine({ workspaceRoot: context.cwd, store, discovery });
	const journal = new JournalStore({ transactionsRoot: join(privateRoot, "transactions") });
	const cursorWriter = new DurableCursorWriter();
	const workspaceLock = new WorkspaceLock();
	let commandContext: ExtensionCommandContext | undefined;
	let internalNavigation = false;
	const capture = async (scopePaths?: readonly string[]) => {
		const topology = await discovery.discover(context.cwd);
		if (topology.workspaceIdentity !== initialTopology.workspaceIdentity) {
			throw new Error("workspace identity 已变化");
		}
		return store.capture(topology, scopePaths);
	};
	const recovery = new JournalRecovery({
		sessionIdentity,
		workspaceIdentity: initialTopology.workspaceIdentity,
		getLogicalLeafId: () => sessionStateFor(manager).getLogicalLeafId(),
		loadPending: () => journal.loadPending(),
		inspectCursor: (pending) => inspectCursorMarkers(pending.descriptor.sessionIdentity.path, pending.descriptor),
		finalizeCursor: (pending, inspection) => finalizeCursorMarker(
			pending.descriptor.sessionIdentity.path,
			pending.descriptor,
			inspection,
		),
		recoverMutations: async (pending, decision) => {
			const mutationJournal = journal.mutationJournal(pending.descriptor.opId);
			if (await hasDurablePack(mutationJournal)) {
				const result = await recoverPackedMutations({
					workspaceRoot: context.cwd,
					journal: mutationJournal,
					planDigest: pending.descriptor.planDigest,
					decision,
					retainArtifacts: decision === "roll_forward",
				});
				if (result.kind === "clean" && decision === "roll_forward") {
					await finalizeDurablePack(mutationJournal, context.cwd);
					await cleanupPackedMutations({
						workspaceRoot: context.cwd,
						journal: mutationJournal,
						planDigest: pending.descriptor.planDigest,
					});
				}
				return result;
			}
			const quarantine = new QuarantineManager({ workspaceRoot: context.cwd, journal: mutationJournal });
			try {
				const loaded = await mutationJournal.load();
				const scopePaths = pending.descriptor.scopePaths;
				if (loaded.some((record) => !scopePaths.some((scope) =>
					scope === "." || record.path === scope || record.path.startsWith(`${scope}/`)
				))) {
					throw new Error("mutation journal path 超出 descriptor scope");
				}
				const records = loaded.filter((record) => record.state !== "CLEANED");
				if (decision === "rollback") records.reverse();
				for (const record of records) {
					if (decision === "rollback") {
						await quarantine.restoreMutation(record);
						continue;
					}
					await quarantine.rollForwardMutation(record);
					const latest = (await mutationJournal.load()).find((candidate) => candidate.ordinal === record.ordinal);
					if (latest === undefined) throw new Error("mutation ordinal 在恢复期间丢失");
					await quarantine.cleanupMutation(latest);
				}
				await mutationJournal.assertCleaned();
				return { kind: "clean" } as const;
			} catch {
				const active = await mutationJournal.load().catch(() => []);
				return {
					kind: "conflict" as const,
					paths: Math.max(1, active.filter((record) => record.state !== "CLEANED").length),
				};
			}
		},
		capture,
		loadManifest: (manifestId) => store.loadManifest(manifestId),
		planRestore: (current, target, scopePaths) => restore.plan(current, target, scopePaths),
		applyRestore: (plan, target, operation) => restore.apply(plan, target, {
			opId: operation.opId,
			mutationJournal: journal.mutationJournal(operation.opId),
			forceTargetArtifactSync: true,
		}),
		settle: (opId, phase) => journal.settleRecovery(opId, phase),
	});

	let finalizationQueue: Promise<void> = Promise.resolve();
	let finalizationFailure: unknown;
	const waitForFinalization = async (): Promise<void> => {
		await finalizationQueue;
		if (finalizationFailure !== undefined) throw finalizationFailure;
	};
	const scheduleFinalization = (opId: string): void => {
		finalizationQueue = finalizationQueue.then(async () => {
			const lease = await workspaceLock.acquire(initialTopology.workspaceIdentity);
			try {
				const mutationJournal = journal.mutationJournal(opId);
				const pack = await loadDurablePack(mutationJournal, undefined, true);
				const recovered = await recoverPackedMutations({
					workspaceRoot: context.cwd,
					journal: mutationJournal,
					planDigest: pack.planDigest,
					decision: "roll_forward",
					retainArtifacts: true,
				});
				if (recovered.kind !== "clean") throw new Error("durable finalization mutation conflict");
				await finalizeDurablePack(mutationJournal, context.cwd);
				await cleanupPackedMutations({
					workspaceRoot: context.cwd,
					journal: mutationJournal,
					planDigest: pack.planDigest,
				});
				await journal.markCommitted(opId);
			} finally {
				await lease.release();
			}
		}).catch((error: unknown) => {
			finalizationFailure = error;
		});
	};
	const transactionJournal: ControllerDependencies["journal"] = {
		prepare: (descriptor, plan) => journal.prepare(descriptor, plan),
		setPhase: (opId, phase, options) => journal.setPhase(opId, phase, options),
		setPhases: (opId, transitions) => journal.setPhases(opId, transitions),
		markCommitted: async (opId) => {
			const mutationJournal = journal.mutationJournal(opId);
			if (!await hasDurablePack(mutationJournal)) {
				await journal.markCommitted(opId);
				return;
			}
			await journal.assertLogicalCommitReady(opId, true);
			scheduleFinalization(opId);
		},
		loadPending: () => journal.loadPending(),
	};

	const dependencies: ControllerDependencies = {
		workspaceIdentity: initialTopology.workspaceIdentity,
		sessionIdentity,
		isAgentIdle: () => context.isIdle(),
		abortAgent: async () => { context.abort(); },
		waitForIdle: async (deadlineMs) => waitForIdle(commandContext, deadlineMs),
		getLogicalLeafId: () => sessionStateFor(manager).getLogicalLeafId(),
		acquireWorkspaceLock: async () => {
			await waitForFinalization();
			return workspaceLock.acquire(initialTopology.workspaceIdentity);
		},
		findUserEntryAfter: (startEntryId) => findUserEntryAfter(manager, startEntryId),
		resolveSessionTarget: (action, checkpoint) => action === "undo"
			? logicalLeafAt(manager, entryParent(manager, checkpoint.userEntryId))
			: checkpoint.endLeafId,
		navigateSession: async (action, checkpoint) => {
			if (commandContext === undefined) throw new Error("command context 不可用");
			const targetId = action === "undo" ? checkpoint.userEntryId : checkpoint.endLeafId;
			internalNavigation = true;
			try {
				const result = await commandContext.navigateTree(targetId, { summarize: false });
				return { cancelled: result.cancelled, logicalLeafId: sessionStateFor(manager).getLogicalLeafId() };
			} finally {
				internalNavigation = false;
			}
		},
		restoreSessionLeaf: async (logicalLeafId) => {
			if (commandContext === undefined || logicalLeafId === null) return false;
			internalNavigation = true;
			try {
				const result = await commandContext.navigateTree(logicalLeafId, { summarize: false });
				return !result.cancelled && sessionStateFor(manager).getLogicalLeafId() === logicalLeafId;
			} finally {
				internalNavigation = false;
			}
		},
		resolveTreeTarget: async (targetEntryId) => resolveTreeTarget(manager, sessionIdentity, targetEntryId),
		appendControl: async (customType, data) => appendControlEntry(pi, manager, customType, data),
		appendCursor: async (cursor) => cursorWriter.appendCursor(cursor, pi, sourceFor(manager)),
		capture,
		captureSafety: async (referenceManifestId, targetManifestId, scopePaths) => {
			const [reference, target] = await Promise.all([
				store.loadManifest(referenceManifestId),
				store.loadManifest(targetManifestId),
			]);
			if (await restore.canReuseDurableSource(reference, target, scopePaths)) return reference;
			return capture(scopePaths);
		},
		changedPaths: async (before, after) => {
			const plan = await restore.plan(before, after);
			return [...new Set([...plan.deletePaths, ...plan.writePaths])].sort();
		},
		loadManifest: (manifestId) => store.loadManifest(manifestId),
		planRestore: (current, target, scopePaths) => restore.plan(current, target, scopePaths),
		prepareDurableRestore: (current, target, scopePaths) =>
			restore.prepareDurableRestore(current, target, scopePaths),
		applyRestore: (plan, target, operation) => restore.apply(plan, target, {
			opId: operation.opId,
			mutationJournal: journal.mutationJournal(operation.opId),
			deferDurability: true,
		}),
		recoverPending: async () => {
			await waitForFinalization();
			return workspaceLock.withLock(initialTopology.workspaceIdentity, () => recovery.recover());
		},
		journal: transactionJournal,
		clock: Date.now,
	};
	const startupRecovery = await workspaceLock.withLock(
		initialTopology.workspaceIdentity,
		() => recovery.recover(),
	);
	const controller = new UndoControllerImpl(dependencies, {
		...rebuildControllerState(manager, sessionIdentity),
		locked: startupRecovery.kind === "locked",
	});
	return {
		controller,
		reporter: new StatusReporter(context),
		diffSource: store,
		recovery: startupRecovery.kind === "locked"
			? { files: startupRecovery.files, opId: startupRecovery.opId }
			: undefined,
		setCommandContext(next: ExtensionCommandContext | undefined): void {
			commandContext = next;
		},
		isInternalNavigation(): boolean {
			return internalNavigation;
		},
	};
}

function rebuildControllerState(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
): ControllerInitialState {
	const state = sessionStateFor(manager);
	const checkpoints = state.getCheckpoints(identity);
	const cursor = state.getCursor(identity);
	let undoStack = [...checkpoints];
	if (cursor !== null) {
		if (cursor.undoHead === null) {
			undoStack = [];
		} else {
			undoStack = checkpointFrontierById(manager, identity, cursor.undoHead);
		}
	}
	const redoStack = cursor === null ? [] : cursor.redoStack.map((checkpointId, index) => {
		const checkpoint = findCheckpointById(manager, identity, checkpointId);
		if (checkpoint === undefined) throw new Error("cursor redo checkpoint 不可信");
		const prefix = cursor.redoStack.slice(0, index + 1);
		const sourceCursor = validCursors(manager, identity)
			.filter((candidate) => candidate.action === "undo" && sameStrings(candidate.redoStack, prefix))
			.at(-1);
		if (sourceCursor === undefined) throw new Error("cursor redo safety manifest 缺失");
		return { checkpoint, targetManifestId: sourceCursor.rollbackManifestId };
	});
	const branch = physicalBranch(manager, manager.getLeafId());
	const lastBarrier = findLastIndex(branch, (entry) => entry.type === "custom" && entry.customType === "pi-undo:barrier");
	const lastCheckpoint = findLastIndex(branch, (entry) => entry.type === "custom" && entry.customType === "pi-undo:checkpoint");
	return { undoStack, redoStack, historyPaused: lastBarrier > lastCheckpoint };
}

function checkpointFrontierById(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
	checkpointId: string,
): CheckpointRecord[] {
	for (const entry of manager.getEntries() as unknown[]) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-undo:checkpoint" || typeof entry.id !== "string") continue;
		const frontier = sessionStateFor(manager, entry.id).getCheckpoints(identity);
		const index = frontier.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
		if (index >= 0) return frontier.slice(0, index + 1);
	}
	throw new Error("cursor undoHead 不在可信 checkpoint branch");
}

async function appendControlEntry(
	pi: ExtensionAPI,
	manager: ReadonlySessionManager,
	customType: string,
	data?: unknown,
): Promise<string | null> {
	pi.appendEntry(customType, data);
	const leafId = manager.getLeafId();
	if (leafId === null) return null;
	const entry = manager.getEntry(leafId) as unknown;
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== customType) return null;
	if (canonicalJson(entry.data) !== canonicalJson(data ?? null) && entry.data !== data) return null;
	return leafId;
}

function sessionStateFor(manager: ReadonlySessionManager, leafId = manager.getLeafId()): SessionState {
	return new SessionState(sourceFor(manager, leafId));
}

function sourceFor(manager: ReadonlySessionManager, leafId?: string | null): SessionEntrySource {
	return {
		getEntries: () => manager.getEntries(),
		getLeafId: () => leafId === undefined ? manager.getLeafId() : leafId,
		getSessionFile: () => manager.getSessionFile(),
	};
}

function findUserEntryAfter(manager: ReadonlySessionManager, startEntryId: string): string | null {
	const entries = manager.getEntries() as unknown[];
	for (const value of entries) {
		if (!isRecord(value) || value.parentId !== startEntryId || value.type !== "message" || !isRecord(value.message)) continue;
		if (value.message.role === "user" && typeof value.id === "string") return value.id;
	}
	return null;
}

function entryParent(manager: ReadonlySessionManager, entryId: string): string | null {
	const entry = manager.getEntry(entryId) as unknown;
	if (!isRecord(entry) || (entry.parentId !== null && typeof entry.parentId !== "string")) {
		throw new Error("session target entry 无效");
	}
	return entry.parentId;
}

function logicalLeafAt(manager: ReadonlySessionManager, leafId: string | null): string | null {
	return sessionStateFor(manager, leafId).getLogicalLeafId();
}

async function resolveTreeTarget(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
	targetEntryId: string | null,
): Promise<{ logicalLeafId: string | null; targetManifestId: ManifestId; undoStack: readonly CheckpointRecord[] }> {
	if (targetEntryId === null) throw new Error("tree target 缺失");
	const target = manager.getEntry(targetEntryId) as unknown;
	if (!isRecord(target)) throw new Error("tree target 不存在");
	const isUser = target.type === "message" && isRecord(target.message) && target.message.role === "user";
	const physicalLeaf = isUser || target.type === "custom_message" ? entryParent(manager, targetEntryId) : targetEntryId;
	const logicalLeafId = logicalLeafAt(manager, physicalLeaf);
	if (isUser) {
		const checkpoint = findCheckpointByUserEntry(manager, identity, targetEntryId);
		if (checkpoint === undefined) throw new Error("tree target 缺少 before checkpoint");
		return {
			logicalLeafId,
			targetManifestId: checkpoint.beforeManifestId,
			undoStack: sessionStateFor(manager, physicalLeaf).getCheckpoints(identity),
		};
	}
	let checkpoints = [...sessionStateFor(manager, physicalLeaf).getCheckpoints(identity)];
	const exact = findCheckpointByEndLeaf(manager, identity, logicalLeafId);
	if (exact !== undefined) checkpoints = checkpointFrontierById(manager, identity, exact.checkpointId);
	const checkpoint = exact ?? checkpoints.at(-1);
	if (checkpoint === undefined) throw new Error("tree target 缺少完整 checkpoint");
	return { logicalLeafId, targetManifestId: checkpoint.afterManifestId, undoStack: checkpoints };
}

function findCheckpointByEndLeaf(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
	endLeafId: string | null,
): CheckpointRecord | undefined {
	if (endLeafId === null) return undefined;
	const matches: CheckpointRecord[] = [];
	for (const entry of manager.getEntries() as unknown[]) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-undo:checkpoint" || typeof entry.id !== "string") continue;
		const checkpoint = sessionStateFor(manager, entry.id).getCheckpoints(identity)
			.find((candidate) => candidate.endLeafId === endLeafId);
		if (checkpoint !== undefined) matches.push(checkpoint);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

function findCheckpointByUserEntry(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
	userEntryId: string,
): CheckpointRecord | undefined {
	for (const entry of manager.getEntries() as unknown[]) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-undo:checkpoint" || typeof entry.id !== "string") continue;
		const checkpoint = sessionStateFor(manager, entry.id).getCheckpoints(identity)
			.find((candidate) => candidate.userEntryId === userEntryId);
		if (checkpoint !== undefined) return checkpoint;
	}
	return undefined;
}

function findCheckpointById(
	manager: ReadonlySessionManager,
	identity: SessionFileIdentity,
	checkpointId: string,
): CheckpointRecord | undefined {
	for (const entry of manager.getEntries() as unknown[]) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-undo:checkpoint" || typeof entry.id !== "string") continue;
		const checkpoint = sessionStateFor(manager, entry.id).getCheckpoints(identity)
			.find((candidate) => candidate.checkpointId === checkpointId);
		if (checkpoint !== undefined) return checkpoint;
	}
	return undefined;
}

function validCursors(manager: ReadonlySessionManager, identity: SessionFileIdentity) {
	const cursors = [];
	for (const entry of manager.getEntries() as unknown[]) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-undo:cursor") continue;
		try {
			const cursor = assertCursor(entry.data);
			if (sameIdentity(cursor.sessionIdentity, identity)) cursors.push(cursor);
		} catch {
			// 旧分支中的损坏 cursor 不参与 frontier 重建。
		}
	}
	return cursors;
}

function physicalBranch(manager: ReadonlySessionManager, leafId: string | null): Record<string, unknown>[] {
	const entries = new Map<string, Record<string, unknown>>();
	for (const entry of manager.getEntries() as unknown[]) {
		if (isRecord(entry) && typeof entry.id === "string") entries.set(entry.id, entry);
	}
	const branch: Record<string, unknown>[] = [];
	const visited = new Set<string>();
	let current = leafId;
	while (current !== null) {
		if (visited.has(current)) throw new Error("session parent cycle");
		visited.add(current);
		const entry = entries.get(current);
		if (entry === undefined) throw new Error("session parent 缺失");
		branch.push(entry);
		if (entry.parentId !== null && typeof entry.parentId !== "string") throw new Error("session parent 无效");
		current = entry.parentId;
	}
	return branch.reverse();
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		if (predicate(values[index]!)) return index;
	}
	return -1;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIdentity(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
	return resolve(left.path) === resolve(right.path) && left.headerChecksum === right.headerChecksum;
}

function volatileSessionIdentity(manager: ReadonlySessionManager, cwd: string): SessionFileIdentity {
	const header = manager.getHeader() as unknown;
	const record = isRecord(header) ? header : {};
	const content = {
		id: typeof record.id === "string" ? record.id : manager.getSessionId(),
		timestamp: typeof record.timestamp === "string" ? record.timestamp : "volatile",
		cwd: typeof record.cwd === "string" ? record.cwd : cwd,
	};
	return {
		path: resolve(manager.getSessionFile() ?? join(manager.getSessionDir(), `.pi-undo/volatile-${manager.getSessionId()}.jsonl`)),
		headerChecksum: checksum(canonicalJson(content)),
	};
}

async function waitForIdle(context: ExtensionCommandContext | undefined, deadlineMs: number): Promise<boolean> {
	if (context === undefined) return false;
	const remaining = Math.max(0, deadlineMs - Date.now());
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			context.waitForIdle().then(() => true, () => false),
			new Promise<boolean>((resolveTimeout) => {
				timeout = setTimeout(() => resolveTimeout(false), remaining);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
