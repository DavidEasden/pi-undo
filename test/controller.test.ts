import { describe, expect, it } from "vitest";

import { UndoControllerImpl, type ControllerDependencies } from "../src/controller.ts";
import { canonicalJson, checksum } from "../src/encoding.ts";
import type { CheckpointRecord, CursorState, ManifestId, SessionFileIdentity, SnapshotManifest } from "../src/model.ts";

const identity: SessionFileIdentity = { path: "/sessions/pi.jsonl", headerChecksum: "a".repeat(64) };

function manifest(seed: string): SnapshotManifest {
	return {
		schemaVersion: 1,
		manifestId: seed.repeat(64) as ManifestId,
		workspaceIdentity: "/workspace",
		topologyFingerprint: "b".repeat(64),
		coverage: "complete",
		roots: [],
		createdAt: "2026-07-25T00:00:00.000Z",
	};
}

function restoredCheckpoint(checkpointId = "restored-checkpoint"): CheckpointRecord {
	const payload = {
		schemaVersion: 1 as const,
		checkpointId,
		runId: `run-${checkpointId}`,
		sessionIdentity: identity,
		startEntryId: `start-${checkpointId}`,
		userEntryId: `user-${checkpointId}`,
		endLeafId: `assistant-${checkpointId}`,
		rawPrompt: "恢复的 prompt",
		beforeManifestId: "a".repeat(64) as ManifestId,
		afterManifestId: "b".repeat(64) as ManifestId,
		changedPaths: ["file.txt"],
	};
	return { ...payload, checksum: checksum(canonicalJson(payload)) };
}

function dependencies(overrides: Partial<ControllerDependencies> = {}): ControllerDependencies & { calls: string[] } {
	const calls: string[] = [];
	let leaf = "assistant-1";
	return {
		calls,
		workspaceIdentity: "/workspace",
		sessionIdentity: identity,
		isAgentIdle: () => true,
		abortAgent: async () => { calls.push("abort"); },
		waitForIdle: async () => { calls.push("idle"); return true; },
		getLogicalLeafId: () => leaf,
		acquireWorkspaceLock: async () => ({ release: async () => {} }),
		findUserEntryAfter: () => "user-1",
		resolveSessionTarget: (action, checkpoint) => action === "undo" ? "assistant-before" : checkpoint.endLeafId,
		navigateSession: async (action, checkpoint) => {
			calls.push("navigate");
			return { cancelled: false, logicalLeafId: action === "undo" ? "assistant-before" : checkpoint.endLeafId };
		},
		restoreSessionLeaf: async () => { calls.push("session-rollback"); return true; },
		resolveTreeTarget: async () => ({
			logicalLeafId: "tree-leaf",
			targetManifestId: "a".repeat(64) as ManifestId,
			undoStack: [],
		}),
		appendControl: async (type) => { calls.push(`entry:${type}`); leaf = `${type}-leaf`; return leaf; },
		appendCursor: async () => { calls.push("cursor"); return { kind: "durable", logicalLeafId: leaf }; },
		capture: async () => { calls.push("capture"); return manifest(calls.filter((item) => item === "capture").length === 1 ? "a" : "c"); },
		changedPaths: async () => ["file.txt"],
		planRestore: async (current, target) => ({
			currentManifestId: current.manifestId,
			targetManifestId: target.manifestId,
			boundaryRoots: ["."],
			deletePaths: [],
			writePaths: ["file.txt"],
			planDigest: checksum(canonicalJson({ current: current.manifestId, target: target.manifestId })),
		}),
		applyRestore: async () => { calls.push("restore"); return { code: "ok", verifiedPaths: 1, totalPaths: 1 }; },
		loadManifest: async (id) => id === "a".repeat(64) ? manifest("a") : manifest("c"),
		recoverPending: async () => ({ kind: "clean", operations: 0 }),
		journal: {
			prepare: async () => { calls.push("prepare"); },
			setPhase: async (_id, phase) => { calls.push(`phase:${phase}`); },
			markCommitted: async () => { calls.push("committed"); },
			loadPending: async () => [],
		},
		clock: () => 0,
		...overrides,
	};
}

describe("UndoController", () => {
	it("session_start 可注入已验证的 undo/redo frontier", async () => {
		const undoCheckpoint = restoredCheckpoint("undo-restored");
		const redoCheckpoint = restoredCheckpoint("redo-restored");
		const deps = dependencies();
		const controller = new UndoControllerImpl(deps, {
			undoStack: [undoCheckpoint],
			redoStack: [{ checkpoint: redoCheckpoint, targetManifestId: "d".repeat(64) as ManifestId }],
		});

		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 1, locked: false });
		expect((await controller.redo()).code).toBe("ok");
	});

	it("session_start 自动恢复已验证 journal，只有冲突结果才锁住历史", async () => {
		const recoveredDeps = dependencies({
			recoverPending: async () => ({ kind: "recovered", operations: 1 }),
		} as any);
		const recovered = new UndoControllerImpl(recoveredDeps);
		await recovered.recover();
		expect(recovered.history().locked).toBe(false);

		const lockedDeps = dependencies({
			recoverPending: async () => ({ kind: "locked", reason: "cursor_conflict", operations: 0 }),
		} as any);
		const locked = new UndoControllerImpl(lockedDeps);
		await locked.recover();
		expect(locked.history().locked).toBe(true);
	});

	it("没有 checkpoint 的 undo/redo 是 noop，且不会快照或恢复", async () => {
		const deps = dependencies();
		const controller = new UndoControllerImpl(deps);

		expect(await controller.undo()).toMatchObject({ code: "noop" });
		expect(await controller.redo()).toMatchObject({ code: "noop" });
		expect(deps.calls).toEqual([]);
	});

	it("正常 run 只在 idle 输入建立 baseline，并在 settled 后持久化 checkpoint", async () => {
		const deps = dependencies();
		const controller = new UndoControllerImpl(deps);

		expect(await controller.prepareInput("修复文件", { streaming: false })).toEqual({ action: "continue" });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(deps.calls).toEqual(["capture", "entry:pi-undo:start", "capture", "entry:pi-undo:checkpoint"]);
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("normal run 的 before/after capture 均在 workspace lease 内完成", async () => {
		const deps = dependencies({
			acquireWorkspaceLock: async () => {
				deps.calls.push("lock");
				return { release: async () => { deps.calls.push("unlock"); } };
			},
		} as any);
		const controller = new UndoControllerImpl(deps);

		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(deps.calls).toEqual([
			"lock", "capture", "unlock", "entry:pi-undo:start",
			"lock", "capture", "unlock", "entry:pi-undo:checkpoint",
		]);
	});

	it("checkpoint 使用 start entry 后实际持久化的 user entry", async () => {
		let checkpointData: unknown;
		const deps = dependencies({
			appendControl: async (type, data) => {
				if (type === "pi-undo:checkpoint") checkpointData = data;
				return type === "pi-undo:start" ? "start-1" : "checkpoint-entry";
			},
		}) as ControllerDependencies & {
			calls: string[];
			findUserEntryAfter(startEntryId: string): string | null;
		};
		deps.findUserEntryAfter = (startEntryId) => startEntryId === "start-1" ? "user-1" : null;
		const controller = new UndoControllerImpl(deps);

		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(checkpointData).toMatchObject({ startEntryId: "start-1", userEntryId: "user-1" });
	});

	it("streaming 输入不建立新 boundary，before capture 失败会 handled 但允许重试", async () => {
		const deps = dependencies({ capture: async () => { throw new Error("snapshot failed"); } });
		const controller = new UndoControllerImpl(deps);

		expect(await controller.prepareInput("继续", { streaming: true })).toEqual({ action: "continue" });
		expect(await controller.prepareInput("新的", { streaming: false })).toEqual({ action: "handled" });
		expect(controller.history()).toEqual({ undoCount: 0, redoCount: 0, locked: false });
	});

	it("after capture 失败写 barrier 暂停历史，下一次成功 baseline 可重新开始", async () => {
		let captures = 0;
		const deps = dependencies({
			capture: async () => {
				captures += 1;
				if (captures === 2) throw new Error("after capture failed");
				return manifest(captures === 1 ? "a" : "c");
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("失败轮", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(await controller.undo()).toEqual({ code: "history_paused", changedFiles: 0 });
		expect(deps.calls).toContain("entry:pi-undo:barrier");
		expect(await controller.prepareInput("恢复轮", { streaming: false })).toEqual({ action: "continue" });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("start entry 未获得物理 ID 时不生成不可信 checkpoint，并写 barrier 锁住历史", async () => {
		const deps = dependencies();
		const originalAppend = deps.appendControl;
		Object.assign(deps, {
			appendControl: async (type: string, data?: unknown) => type === "pi-undo:start"
				? null
				: originalAppend(type, data),
		});
		const controller = new UndoControllerImpl(deps);

		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(controller.history()).toEqual({ undoCount: 0, redoCount: 0, locked: true });
		expect(deps.calls).toContain("entry:pi-undo:barrier");
	});

	it("start entry append 抛错时 beforeAgentStart 不向 Pi 传播异常并进入 recovery lock", async () => {
		const deps = dependencies({
			appendControl: async (type) => {
				if (type === "pi-undo:start") throw new Error("append ambiguous");
				return "barrier-1";
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });

		await expect(controller.beforeAgentStart()).resolves.toBeUndefined();
		expect(controller.history().locked).toBe(true);
	});

	it("checkpoint entry 未获得物理 ID 时不推进 undo 栈", async () => {
		const deps = dependencies({
			appendControl: async (type) => {
				deps.calls.push(`entry:${type}`);
				if (type === "pi-undo:start") return "start-1";
				if (type === "pi-undo:checkpoint") return null;
				return "barrier-1";
			},
		});
		const controller = new UndoControllerImpl(deps);

		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(controller.history()).toEqual({ undoCount: 0, redoCount: 0, locked: true });
		expect(deps.calls).toContain("entry:pi-undo:barrier");
	});

	it("undo 只有 durable cursor 后才推进栈，且日志 phase 严格有序", async () => {
		let calls: string[] = [];
		const deps = dependencies({
			resolveSessionTarget: () => "assistant-before",
			navigateSession: async () => {
				calls.push("navigate");
				return { cancelled: false, logicalLeafId: "assistant-before" };
			},
		});
		calls = deps.calls;
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toMatchObject({ code: "ok", changedFiles: 1 });
		expect(deps.calls).toEqual([
			"capture", "prepare", "navigate", "phase:SESSION_MOVED", "phase:APPLYING", "restore",
			"phase:FILES_VERIFIED", "cursor", "phase:CURSOR_COMMITTED", "committed",
		]);
		expect(controller.history()).toEqual({ undoCount: 0, redoCount: 1, locked: false });
	});

	it("undo/redo restore saga 在 cursor 与 journal 提交后才释放 workspace lease", async () => {
		const deps = dependencies({
			acquireWorkspaceLock: async () => {
				deps.calls.push("lock");
				return { release: async () => { deps.calls.push("unlock"); } };
			},
		} as any);
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect((await controller.undo()).code).toBe("ok");
		expect(deps.calls[0]).toBe("lock");
		expect(deps.calls.at(-2)).toBe("committed");
		expect(deps.calls.at(-1)).toBe("unlock");
	});

	it("undo restore plan 只使用 checkpoint changedPaths", async () => {
		let observedScope: readonly string[] | undefined;
		const deps = dependencies({
			planRestore: async (current: SnapshotManifest, target: SnapshotManifest, scopePaths: readonly string[] | undefined) => {
				observedScope = scopePaths;
				return {
					currentManifestId: current.manifestId,
					targetManifestId: target.manifestId,
					boundaryRoots: ["."],
					deletePaths: [],
					writePaths: ["file.txt"],
					scopePaths: scopePaths === undefined ? undefined : [...scopePaths],
					planDigest: checksum(canonicalJson({ current: current.manifestId, target: target.manifestId })),
				};
			},
		} as any);
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect((await controller.undo()).code).toBe("ok");
		expect(observedScope).toEqual(["file.txt"]);
	});

	it("session 导航取消或 observed logical leaf 不匹配时不恢复文件", async () => {
		const deps = dependencies({
			resolveSessionTarget: () => "assistant-before",
			navigateSession: async () => ({ cancelled: false, logicalLeafId: "unexpected-leaf" }),
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toMatchObject({ code: "recovery_required" });
		expect(deps.calls).not.toContain("restore");
		expect(controller.history().locked).toBe(true);
	});

	it("目标预检失败时安全退出，不写 journal、不导航、不锁历史", async () => {
		const deps = dependencies({ loadManifest: async () => { throw new Error("manifest incomplete"); } });
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toEqual({ code: "restore_failed_safe", changedFiles: 0 });
		expect(deps.calls).toEqual(["capture"]);
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("Pi 明确取消 session 导航时 journal 安全终止且不锁历史", async () => {
		const deps = dependencies({
			navigateSession: async () => ({ cancelled: true, logicalLeafId: "assistant-before" }),
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toEqual({ code: "restore_failed_safe", changedFiles: 0 });
		expect(deps.calls).toEqual(["capture", "prepare", "phase:ABORTING", "phase:ABORTED"]);
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("undo safety capture 失败时栈与历史锁保持不变", async () => {
		let captures = 0;
		const deps = dependencies({
			capture: async () => {
				captures += 1;
				if (captures === 3) throw new Error("safety capture failed");
				return manifest(captures === 1 ? "a" : "c");
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toEqual({ code: "capture_failed", changedFiles: 0 });
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
		expect(deps.calls).toEqual([]);
	});

	it("等待 agent idle 超时或 reject 时不 capture、不恢复且不锁历史", async () => {
		const deps = dependencies({
			isAgentIdle: () => false,
			waitForIdle: async () => { throw new Error("idle wait rejected"); },
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toEqual({ code: "idle_timeout", changedFiles: 0 });
		expect(deps.calls).toEqual(["abort"]);
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("redo 恢复 undo safety manifest，而不是 checkpoint 原始 after manifest", async () => {
		let captures = 0;
		const loaded: string[] = [];
		const deps = dependencies({
			capture: async () => {
				captures += 1;
				return manifest(["a", "b", "d", "e"][captures - 1] ?? "f");
			},
			loadManifest: async (id) => {
				loaded.push(id);
				return manifest(id[0]!);
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect((await controller.undo()).code).toBe("ok");
		expect((await controller.redo()).code).toBe("ok");
		expect(loaded).toEqual(["a".repeat(64), "d".repeat(64)]);
	});

	it("连续 undo 的 cursor 保存完整 redo frontier 与下一 undo head", async () => {
		const cursors: CursorState[] = [];
		const deps = dependencies({
			appendCursor: async (state) => {
				cursors.push(state);
				return { kind: "durable", logicalLeafId: state.toLogicalLeaf };
			},
		});
		const controller = new UndoControllerImpl(deps);
		for (const prompt of ["第一轮", "第二轮"]) {
			await controller.prepareInput(prompt, { streaming: false });
			await controller.beforeAgentStart();
			await controller.agentSettled();
		}

		expect((await controller.undo()).code).toBe("ok");
		expect((await controller.undo()).code).toBe("ok");
		expect(cursors).toHaveLength(2);
		expect(cursors[0]!.undoHead).not.toBeNull();
		expect(cursors[0]!.redoStack).toHaveLength(1);
		expect(cursors[1]!.undoHead).toBeNull();
		expect(cursors[1]!.redoStack).toEqual([cursors[0]!.redoStack[0], expect.any(String)]);
	});

	it("cursor 未耐久时补偿 session 与文件，成功后栈保持不变", async () => {
		const deps = dependencies({
			appendCursor: async () => ({ kind: "volatile", reason: "session_file_unavailable" }),
			restoreSessionLeaf: async () => {
				deps.calls.push("session-rollback");
				return true;
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toMatchObject({ code: "restore_failed_safe" });
		expect(deps.calls).toContain("session-rollback");
		expect(deps.calls.filter((call) => call === "restore")).toHaveLength(2);
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("cursor marker 可能已落盘但 branch 证明失败时保留 WAL 并锁定，不执行错误补偿", async () => {
		const deps = dependencies({
			appendCursor: async () => ({ kind: "recovery_required", reason: "cursor_missing" }),
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();
		deps.calls.length = 0;

		expect(await controller.undo()).toEqual({ code: "recovery_required", changedFiles: 1 });
		expect(deps.calls).not.toContain("session-rollback");
		expect(deps.calls.filter((call) => call === "restore")).toHaveLength(1);
		expect(deps.calls).toContain("phase:RECOVERY_REQUIRED");
		expect(controller.history().locked).toBe(true);
	});

	it("SESSION_MOVED journal 持久化 observed logical leaf", async () => {
		let observed: string | null | undefined;
		const deps = dependencies();
		deps.journal.setPhase = async (_opId, phase, options) => {
			if (phase === "SESSION_MOVED") observed = options?.observedLogicalLeaf;
		};
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect((await controller.undo()).code).toBe("ok");
		expect(observed).toBe("assistant-before");
	});

	it("不同 controller 即使时钟相同也生成不同 operation ID", async () => {
		const opIds: string[] = [];
		for (let index = 0; index < 2; index += 1) {
			const deps = dependencies({
				clock: () => 0,
				appendCursor: async (state) => {
					opIds.push(state.opId);
					return { kind: "durable", logicalLeafId: state.toLogicalLeaf };
				},
			});
			const controller = new UndoControllerImpl(deps);
			await controller.prepareInput(`第 ${index + 1} 轮`, { streaming: false });
			await controller.beforeAgentStart();
			await controller.agentSettled();
			await controller.undo();
		}

		expect(new Set(opIds).size).toBe(2);
	});

	it("restore 始终接收当前 transaction operation identity", async () => {
		const restoreOpIds: string[] = [];
		const cursorOpIds: string[] = [];
		const deps = dependencies({
			applyRestore: async (_plan, _target, operation) => {
				restoreOpIds.push(operation.opId);
				return { code: "ok", verifiedPaths: 1, totalPaths: 1 };
			},
			appendCursor: async (state) => {
				cursorOpIds.push(state.opId);
				return { kind: "durable", logicalLeafId: state.toLogicalLeaf };
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect((await controller.undo()).code).toBe("ok");
		expect(restoreOpIds).toEqual(cursorOpIds);
	});

	it("恢复失败时尝试回滚；回滚失败进入 recovery lock 并拒绝新 prompt", async () => {
		let restores = 0;
		const deps = dependencies({
			applyRestore: async () => {
				restores += 1;
				return restores === 1
					? { code: "partial_restore", verifiedPaths: 0, totalPaths: 1 }
					: { code: "recovery_required", verifiedPaths: 0, totalPaths: 1 };
			},
		});
		const controller = new UndoControllerImpl(deps);
		await controller.prepareInput("修复文件", { streaming: false });
		await controller.beforeAgentStart();
		await controller.agentSettled();

		expect(await controller.undo()).toMatchObject({ code: "recovery_required" });
		expect(await controller.prepareInput("下一条", { streaming: false })).toEqual({ action: "handled" });
	});

	it("streaming tree 只请求 abort 并取消，不发生文件恢复", async () => {
		const deps = dependencies({ isAgentIdle: () => false });
		const controller = new UndoControllerImpl(deps);

		expect(await controller.beforeTree({ targetLeafId: "old" })).toEqual({ cancel: true });
		expect(deps.calls).toEqual(["abort"]);
	});

	it("tree 在 before 只准备 rescue journal，after 信任 observed leaf 后才恢复", async () => {
		const deps = dependencies({
			resolveTreeTarget: async () => ({ logicalLeafId: "tree-leaf", targetManifestId: "a".repeat(64) as ManifestId, undoStack: [] }),
		} as Partial<ControllerDependencies>);
		const controller = new UndoControllerImpl(deps);

		expect(await controller.beforeTree({ targetLeafId: "requested-entry" })).toBeUndefined();
		expect(deps.calls).toEqual(["capture", "prepare"]);
		await controller.afterTree({ newLeafId: "tree-leaf" });

		expect(deps.calls).toEqual([
			"capture", "prepare", "phase:SESSION_MOVED", "phase:APPLYING", "restore",
			"phase:FILES_VERIFIED", "cursor", "phase:CURSOR_COMMITTED", "committed",
		]);
	});

	it("tree workspace lease 跨越 before/after 两阶段并在完成后释放", async () => {
		const deps = dependencies({
			resolveTreeTarget: async () => ({ logicalLeafId: "tree-leaf", targetManifestId: "a".repeat(64) as ManifestId, undoStack: [] }),
			acquireWorkspaceLock: async () => {
				deps.calls.push("lock");
				return { release: async () => { deps.calls.push("unlock"); } };
			},
		} as any);
		const controller = new UndoControllerImpl(deps);

		await controller.beforeTree({ targetLeafId: "requested-entry" });
		expect(deps.calls).toEqual(["lock", "capture", "prepare"]);
		await controller.afterTree({ newLeafId: "tree-leaf" });
		expect(deps.calls.at(-1)).toBe("unlock");
	});

	it("tree summary cursor 保存 observed leaf 与目标 branch frontier", async () => {
		const targetCheckpoint = restoredCheckpoint("tree-target");
		let cursor: CursorState | undefined;
		const deps = dependencies({
			resolveTreeTarget: async () => ({
				logicalLeafId: "tree-target-leaf",
				targetManifestId: "a".repeat(64) as ManifestId,
				undoStack: [targetCheckpoint],
			}),
			appendCursor: async (value) => {
				cursor = value;
				return { kind: "durable", logicalLeafId: "summary-leaf" };
			},
		} as Partial<ControllerDependencies>);
		const controller = new UndoControllerImpl(deps);

		await controller.beforeTree({ targetLeafId: "requested-entry" });
		await controller.afterTree({ newLeafId: "summary-leaf", navigationTargetLeafId: "tree-target-leaf" });

		expect(cursor).toMatchObject({
			action: "tree",
			toLogicalLeaf: "summary-leaf",
			undoHead: targetCheckpoint.checkpointId,
			redoStack: [],
		});
		expect(controller.history()).toEqual({ undoCount: 1, redoCount: 0, locked: false });
	});

	it("tree observed leaf 与预检目标不一致时进入 recovery lock 且不恢复", async () => {
		const deps = dependencies({
			resolveTreeTarget: async () => ({ logicalLeafId: "tree-leaf", targetManifestId: "a".repeat(64) as ManifestId, undoStack: [] }),
		} as Partial<ControllerDependencies>);
		const controller = new UndoControllerImpl(deps);
		await controller.beforeTree({ targetLeafId: "requested-entry" });
		deps.calls.length = 0;

		await controller.afterTree({ newLeafId: "unexpected-leaf" });

		expect(deps.calls).not.toContain("restore");
		expect(controller.history().locked).toBe(true);
	});
});
