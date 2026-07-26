# External Concurrency Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通文件和 symlink restore 增加 durable mutation WAL、同文件系统 quarantine 和 no-clobber 目标安装，确保外部并发内容不会被静默覆盖。

**Architecture:** 保留 `RestoreEngine` 现有 manifest/preflight/rollback 语义，新增独立的 `MutationJournal` 和 `QuarantineManager`。Controller 在准备 operation descriptor 后把 opId 传入 restore；启动恢复先收敛 quarantine，再依据 durable cursor 将 workspace 收敛到 target 或 rollback manifest。SnapshotStore 仅排除可信 active mutation log 精确列出的 artifact paths。

**Tech Stack:** TypeScript ESM、Node.js `fs/promises`、Git plumbing、Vitest、现有 canonical JSON/checksum/atomic-fs/WAL 基础设施。

---

## 文件结构

- Create: `src/mutation-journal.ts` — mutation hash-chain WAL 的写入、读取、验证和状态推进。
- Create: `src/quarantine.ts` — 同目录 artifact、普通文件/symlink quarantine、no-clobber 安装和单路径恢复。
- Create: `test/mutation-journal.test.ts` — torn tail、checksum、单调状态、fsync 后重载测试。
- Create: `test/quarantine.test.ts` — 普通文件、symlink、外部重建、cleanup 与 crash fixture。
- Modify: `src/model.ts` — mutation record、state、fingerprint 类型。
- Modify: `src/encoding.ts` — mutation record 严格验证。
- Modify: `src/journal.ts` — 为可信 transaction 提供 mutation journal 路径和 settle 前 artifact gate。
- Modify: `src/restore-engine.ts` — 将叶子 mutation 路由到 quarantine，并精确传递 active artifact paths。
- Modify: `src/snapshot-store.ts` — capture 支持精确 exclusions，不按名称前缀忽略。
- Modify: `src/controller.ts` — applyRestore 传 opId，只有 artifact 清理完成才推进 FILES_VERIFIED/COMMITTED。
- Modify: `src/pi-runtime.ts` — 构造 mutation journal/quarantine/recovery 依赖。
- Modify: `src/recovery.ts` — cursor 决策前先恢复 pending per-path mutation。
- Modify: `src/status-reporter.ts` — recovery_required 报告冲突路径数量和 opId，不输出内容。
- Modify: `test/journal.test.ts`, `test/restore-engine.test.ts`, `test/controller.test.ts`, `test/fault-injection.test.ts`, `test/pi-runtime.test.ts`, `test/snapshot-store.test.ts` — 跨组件回归覆盖。
- Modify: `README.md` — 外部并发、quarantine 和恢复语义。

### Task 1: Mutation 数据模型与严格验证

**Files:**
- Modify: `src/model.ts`
- Modify: `src/encoding.ts`
- Test: `test/model.test.ts`

- [ ] **Step 1: 写失败测试，拒绝非单调或 checksum 错误的 mutation record**

在 `test/model.test.ts` 增加：

```ts
import { assertMutationRecord } from "../src/encoding.ts";
import type { MutationRecord } from "../src/model.ts";

function mutationRecord(overrides: Partial<MutationRecord> = {}): MutationRecord {
	const payload = {
		schemaVersion: 1 as const,
		opId: "op-1",
		ordinal: 1,
		state: "INTENT" as const,
		kind: "write" as const,
		path: "src/a.txt",
		sourceArtifact: "src/.pi-undo-q1-a-source",
		targetArtifact: "src/.pi-undo-q1-a-target",
		sourceFingerprint: "a".repeat(64),
		targetFingerprint: "b".repeat(64),
		previousChecksum: null,
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

it("mutation record 必须使用安全路径、合法状态和内容 checksum", () => {
	expect(assertMutationRecord(mutationRecord())).toMatchObject({ state: "INTENT", ordinal: 1 });
	expect(() => assertMutationRecord(mutationRecord({ path: ".git/index" }))).toThrow("Git metadata");
	expect(() => assertMutationRecord(mutationRecord({ checksum: "0".repeat(64) }))).toThrow("checksum");
});
```

- [ ] **Step 2: 运行测试，确认因导出不存在而失败**

Run: `npm test -- test/model.test.ts --reporter=verbose`

Expected: FAIL，提示 `assertMutationRecord` 或 `MutationRecord` 尚不存在。

- [ ] **Step 3: 增加模型类型和验证器**

在 `src/model.ts` 增加：

```ts
export type MutationState =
	| "INTENT"
	| "SOURCE_QUARANTINED"
	| "SOURCE_VERIFIED"
	| "TARGET_INSTALLED"
	| "TARGET_VERIFIED"
	| "CLEANED";

export interface MutationRecord {
	readonly schemaVersion: 1;
	readonly opId: string;
	readonly ordinal: number;
	readonly state: MutationState;
	readonly kind: "write" | "delete" | "symlink";
	readonly path: string;
	readonly sourceArtifact: string;
	readonly targetArtifact: string | null;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
	readonly previousChecksum: string | null;
	readonly checksum: string;
}
```

在 `src/encoding.ts` 增加并导出 `assertMutationRecord(value)`；复用 `assertOperationId`、checksum 校验和 workspace 相对路径规则，明确拒绝绝对路径、`..`、反斜杠、NUL 和任意大小写 `.git` 组件。状态必须是上述六种之一，ordinal 必须为正整数，artifact 必须与原路径父目录相同。

- [ ] **Step 4: 运行模型测试**

Run: `npm test -- test/model.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/model.ts src/encoding.ts test/model.test.ts
git commit -m "feat: validate quarantine mutation records"
```

### Task 2: Append-only MutationJournal

**Files:**
- Create: `src/mutation-journal.ts`
- Create: `test/mutation-journal.test.ts`
- Modify: `src/journal.ts`

- [ ] **Step 1: 写失败测试，证明 hash chain、状态单调和 torn tail 行为**

创建 `test/mutation-journal.test.ts`：

```ts
it("mutation journal fsync 后按 hash chain 重载", async () => {
	const root = await temporaryRoot("pi-undo-mutations-");
	const journal = new MutationJournal(join(root, "mutations.jsonl"), "op-1");
	const intent = await journal.begin({
		kind: "write",
		path: "a.txt",
		sourceArtifact: ".pi-undo-q1-a-source",
		targetArtifact: ".pi-undo-q1-a-target",
		sourceFingerprint: "a".repeat(64),
		targetFingerprint: "b".repeat(64),
	});
	await journal.advance(intent.ordinal, "SOURCE_QUARANTINED");

	const loaded = await new MutationJournal(join(root, "mutations.jsonl"), "op-1").load();
	expect(loaded).toHaveLength(1);
	expect(loaded[0]?.state).toBe("SOURCE_QUARANTINED");
});

it("截断尾记录不升级 mutation 状态", async () => {
	// 先写完整 INTENT，再追加半条 JSON；load 必须保留 INTENT，不能推断后续状态。
});

it("重复 ordinal 的不同 payload 和状态跳跃 fail closed", async () => {
	// SOURCE_QUARANTINED 不能直接跳到 TARGET_INSTALLED；同 ordinal 字段不能变化。
});
```

- [ ] **Step 2: 运行测试，确认模块不存在**

Run: `npm test -- test/mutation-journal.test.ts --reporter=verbose`

Expected: FAIL，提示找不到 `src/mutation-journal.ts`。

- [ ] **Step 3: 实现最小 MutationJournal**

`src/mutation-journal.ts` 对外接口固定为：

```ts
export interface MutationIntent {
	readonly kind: MutationRecord["kind"];
	readonly path: string;
	readonly sourceArtifact: string;
	readonly targetArtifact: string | null;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
}

export class MutationJournal {
	constructor(path: string, opId: string);
	load(): Promise<readonly MutationRecord[]>;
	begin(intent: MutationIntent): Promise<MutationRecord>;
	advance(ordinal: number, state: MutationState): Promise<MutationRecord>;
	activeArtifacts(): Promise<ReadonlySet<string>>;
	assertCleaned(): Promise<void>;
}
```

写入使用 `appendFile` 后调用 `fsyncFile(path)` 和 `fsyncDirectory(dirname(path))`。`load()` 逐行 parse，最后一条 torn JSON 可以忽略；中间损坏、hash chain 断裂、字段变化、重复冲突或状态跳跃必须抛错。`JournalStore` 增加：

```ts
mutationJournal(opId: string): MutationJournal {
	assertOperationId(opId);
	return new MutationJournal(join(this.operationDirectory(opId), "mutations.jsonl"), opId);
}
```

- [ ] **Step 4: 运行 journal 测试**

Run: `npm test -- test/mutation-journal.test.ts test/journal.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/mutation-journal.ts src/journal.ts test/mutation-journal.test.ts test/journal.test.ts
git commit -m "feat: journal per-path quarantine mutations"
```

### Task 3: QuarantineManager 的文件系统原语

**Files:**
- Create: `src/quarantine.ts`
- Create: `test/quarantine.test.ts`
- Modify: `src/atomic-fs.ts`

- [ ] **Step 1: 写失败测试，外部重建目标时不能被覆盖**

创建 `test/quarantine.test.ts`：

```ts
it("source 隔离后原路径被外部重建时 no-clobber 安装失败并保留两个版本", async () => {
	const root = await temporaryRoot("pi-undo-quarantine-");
	await writeFile(join(root, "a.txt"), "source\n");
	const journal = new MutationJournal(join(root, "mutations.jsonl"), "op-1");
	const manager = new QuarantineManager({ workspaceRoot: root, journal });

	await expect(manager.replaceFile({
		path: "a.txt",
		targetBytes: Buffer.from("target\n"),
		targetMode: 0o644,
		sourceFingerprint: await fingerprintFile(join(root, "a.txt")),
		targetFingerprint: fingerprintBytes("a.txt", Buffer.from("target\n"), 0o644),
		beforeInstall: () => writeFile(join(root, "a.txt"), "external\n"),
	})).rejects.toThrow("外部并发");

	expect(await readFile(join(root, "a.txt"), "utf8")).toBe("external\n");
	expect(await manager.inspectArtifacts()).toContainEqual(expect.objectContaining({ role: "source" }));
});
```

另加：普通替换成功、delete 保留 source artifact、symlink link text、artifact 名碰撞、跨设备/不支持 hard-link fail safe、cleanup 幂等测试。

- [ ] **Step 2: 运行测试，确认模块不存在**

Run: `npm test -- test/quarantine.test.ts --reporter=verbose`

Expected: FAIL，提示找不到 `src/quarantine.ts`。

- [ ] **Step 3: 实现 QuarantineManager**

固定接口：

```ts
export interface ReplaceFileRequest {
	readonly path: string;
	readonly targetBytes: Uint8Array;
	readonly targetMode: number;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string;
	readonly beforeInstall?: () => void | Promise<void>;
}

export class QuarantineManager {
	constructor(options: { workspaceRoot: string; journal: MutationJournal });
	replaceFile(request: ReplaceFileRequest): Promise<void>;
	replaceSymlink(request: ReplaceSymlinkRequest): Promise<void>;
	deleteLeaf(request: DeleteLeafRequest): Promise<void>;
	restoreMutation(record: MutationRecord): Promise<void>;
	rollForwardMutation(record: MutationRecord): Promise<void>;
	cleanupMutation(record: MutationRecord): Promise<void>;
	inspectArtifacts(): Promise<readonly QuarantineArtifact[]>;
}
```

普通文件目标 artifact 使用 `open(path, "wx", mode)`、完整 write、`sync()`、close；安装使用 `link(targetArtifact, originalPath)`，遇到 `EEXIST` 返回外部并发冲突，绝不改用覆盖式 rename。source 移到随机同目录 artifact 后立即 fsync 父目录并重新 fingerprint。symlink 安装使用 `symlink(linkText, originalPath)` 的 `EEXIST` 语义。所有 cleanup 仅处理 mutation journal 精确登记且 fingerprint 合法的 artifact。

- [ ] **Step 4: 运行 quarantine 测试**

Run: `npm test -- test/quarantine.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/quarantine.ts src/atomic-fs.ts test/quarantine.test.ts
git commit -m "feat: quarantine leaf mutations before restore"
```

### Task 4: SnapshotStore 精确排除 active artifact

**Files:**
- Modify: `src/snapshot-store.ts`
- Test: `test/snapshot-store.test.ts`

- [ ] **Step 1: 写失败测试，只有显式 exact exclusion 被排除**

```ts
it("capture 只排除调用方证明的 exact artifact path", async () => {
	await writeFixtureFile(workspace, ".pi-undo-q1-owned-source", "owned\n");
	await writeFixtureFile(workspace, ".pi-undo-q1-user-source", "user\n");

	const manifest = await store.capture(topology, undefined, {
		excludePaths: [".pi-undo-q1-owned-source"],
	});
	const paths = (await store.listTree(manifest.manifestId, ".")).map((entry) => entry.relativePath);

	expect(paths).not.toContain(".pi-undo-q1-owned-source");
	expect(paths).toContain(".pi-undo-q1-user-source");
});
```

- [ ] **Step 2: 运行测试，确认 capture 第三个参数尚不存在**

Run: `npm test -- test/snapshot-store.test.ts --reporter=verbose`

Expected: FAIL，TypeScript/运行时显示 capture options 未实现。

- [ ] **Step 3: 实现精确 exclusion**

接口改为：

```ts
export interface CaptureOptions {
	readonly excludePaths?: readonly string[];
}

capture(
	topology: RootTopology,
	scope?: readonly string[],
	options?: CaptureOptions,
): Promise<SnapshotManifest>;
```

对每个 exclusion 执行 canonical relative path、`.git` 拒绝、排序去重，并按 owned root 转为 literal exclude pathspec。禁止 glob、目录前缀和名称前缀匹配。manifest coverage 仍描述用户内容；调用方必须保证 exclusions 来自可信 active mutation log。

- [ ] **Step 4: 运行 snapshot 测试**

Run: `npm test -- test/snapshot-store.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/snapshot-store.ts test/snapshot-store.test.ts
git commit -m "feat: exclude trusted quarantine artifacts from capture"
```

### Task 5: RestoreEngine 接入 quarantine

**Files:**
- Modify: `src/restore-engine.ts`
- Test: `test/restore-engine.test.ts`

- [ ] **Step 1: 写失败测试，mutation 瞬间外部内容不丢失**

```ts
it("source quarantine 后外部重建路径时 restore 不覆盖并保留 WAL", async () => {
	const operation = await restoreFixture({ current: "source\n", target: "target\n" });
	const engine = new RestoreEngine({
		workspaceRoot: operation.workspace,
		store: operation.store,
		discovery: operation.discovery,
		beforeMutation: async ({ kind, path }) => {
			if (kind === "write" && path === "a.txt") {
				await writeFile(operation.workspace, "a.txt", "external\n");
			}
		},
	});

	const result = await engine.apply(operation.plan, operation.target, {
		opId: "op-1",
		mutationJournal: operation.journal,
	});

	expect(result.code).toBe("restore_failed_safe");
	expect(await readFile(join(operation.workspace, "a.txt"), "utf8")).toBe("external\n");
});
```

保留现有测试，另加 apply、rollback、delete、symlink、ignored、nested root 和 submodule 场景。

- [ ] **Step 2: 运行测试，确认 apply options 尚不存在**

Run: `npm test -- test/restore-engine.test.ts --reporter=verbose`

Expected: FAIL，`apply` 第三个参数和 mutation journal 尚未接入。

- [ ] **Step 3: 修改 RestoreEngine 接口和 leaf mutation 路由**

```ts
export interface RestoreApplyOptions {
	readonly opId: string;
	readonly mutationJournal: MutationJournal;
}

export interface RestoreEngine {
	plan(current: SnapshotManifest, target: SnapshotManifest, scopePaths?: readonly string[]): Promise<RestorePlan>;
	apply(plan: RestorePlan, target: SnapshotManifest, options: RestoreApplyOptions): Promise<RestoreResult>;
}
```

`writePath()` 对 file 调用 `QuarantineManager.replaceFile()`，对 symlink 调用 `replaceSymlink()`；`deletePath()` 对叶子调用 `deleteLeaf()`，目录保留 `rmdir`。`assertMutationPath()`、`assertMutationState()` 和 target verification 保留。内部完整 capture 传 `mutationJournal.activeArtifacts()` 作为 exact exclusions。

rollback 必须复用同一个 mutation journal 并推进新的 ordinal，不能删除或覆写 apply 记录。返回 `ok` 或 `restore_failed_safe` 前调用 `assertCleaned()`；无法无损清理时返回 `recovery_required`。

- [ ] **Step 4: 运行 RestoreEngine 与 quarantine 测试**

Run: `npm test -- test/quarantine.test.ts test/restore-engine.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/restore-engine.ts test/restore-engine.test.ts
git commit -m "feat: restore files through atomic quarantine"
```

### Task 6: Controller 与 Pi runtime 传递 operation identity

**Files:**
- Modify: `src/controller.ts`
- Modify: `src/pi-runtime.ts`
- Modify: `src/journal.ts`
- Test: `test/controller.test.ts`
- Test: `test/pi-runtime.test.ts`

- [ ] **Step 1: 写失败测试，FILES_VERIFIED 前必须清理 artifact**

```ts
it("quarantine 未清理时不提交 cursor 并进入 recovery lock", async () => {
	const fixture = controllerFixture({
		applyRestore: async (_plan, _target, operation) => {
			expect(operation.opId).toMatch(/^op-/);
			return { code: "recovery_required", verifiedPaths: 1, totalPaths: 1 };
		},
	});

	expect(await fixture.controller.undo()).toEqual({ code: "recovery_required", changedFiles: 1 });
	expect(fixture.appendedCursors).toEqual([]);
	expect(fixture.phases.at(-1)).toBe("RECOVERY_REQUIRED");
});
```

- [ ] **Step 2: 运行 controller/runtime 测试，确认签名不匹配**

Run: `npm test -- test/controller.test.ts test/pi-runtime.test.ts --reporter=verbose`

Expected: FAIL，applyRestore 尚未接收 operation context。

- [ ] **Step 3: 接线 operation context**

Controller dependency 改为：

```ts
readonly applyRestore: (
	plan: RestorePlan,
	target: SnapshotManifest,
	operation: { readonly opId: string },
) => Promise<RestoreResult>;
```

所有 apply、compensation、tree restore 和 recovery 调用都传 descriptor opId。`pi-runtime.ts` 使用 `journal.mutationJournal(opId)` 构造 `RestoreApplyOptions`。`JournalStore.markCommitted()` 和 `settleRecovery()` 在终态写入前调用 mutation journal `assertCleaned()`。

- [ ] **Step 4: 运行 controller/runtime 测试**

Run: `npm test -- test/controller.test.ts test/pi-runtime.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/controller.ts src/pi-runtime.ts src/journal.ts test/controller.test.ts test/pi-runtime.test.ts
git commit -m "feat: bind quarantine lifecycle to undo transactions"
```

### Task 7: Startup QuarantineRecovery

**Files:**
- Modify: `src/recovery.ts`
- Modify: `src/pi-runtime.ts`
- Modify: `src/status-reporter.ts`
- Test: `test/fault-injection.test.ts`
- Test: `test/extension.integration.test.ts`

- [ ] **Step 1: 写表驱动失败测试覆盖每个 crash state**

```ts
it.each([
	["INTENT", "rollback"],
	["SOURCE_QUARANTINED", "rollback"],
	["SOURCE_VERIFIED", "rollback"],
	["TARGET_INSTALLED", "roll_forward"],
	["TARGET_VERIFIED", "roll_forward"],
] as const)("cursor 决策驱动 %s mutation 收敛", async (state, expected) => {
	const fixture = await quarantineRecoveryFixture({ state, cursor: expected === "roll_forward" ? "match" : "absent" });

	expect(await fixture.recovery.recover()).toMatchObject({ kind: "recovered", operations: 1 });
	expect(await fixture.workspaceState()).toBe(expected === "roll_forward" ? "target" : "rollback");
	expect(await fixture.artifacts()).toEqual([]);
});

it("未知 original 和 artifact 内容全部保留并锁定", async () => {
	const fixture = await quarantineRecoveryFixture({ state: "SOURCE_QUARANTINED", conflict: true });
	expect(await fixture.recovery.recover()).toMatchObject({ kind: "locked", reason: "mutation_conflict" });
	expect(await fixture.allBytes()).toEqual(expect.arrayContaining(["external", "source"]));
});
```

- [ ] **Step 2: 运行 fault injection 测试，确认恢复器尚未读取 mutation WAL**

Run: `npm test -- test/fault-injection.test.ts --reporter=verbose`

Expected: FAIL，pending artifact 未收敛或恢复依赖不存在。

- [ ] **Step 3: 在 manifest capture 前执行 per-path recovery**

`JournalRecoveryDependencies` 增加：

```ts
readonly recoverMutations: (
	journal: PendingJournal,
	decision: "rollback" | "roll_forward",
) => Promise<{ readonly kind: "clean" } | { readonly kind: "conflict"; readonly paths: number }>;
```

`inspectCursor()` 得到 match/absent 后先调用 `recoverMutations`，成功清理 artifact 后才执行 capture/plan/apply。冲突返回 `locked: mutation_conflict`。StatusReporter 显示 `recovery_required files:<n> op:<opId>`，不显示路径内容。

- [ ] **Step 4: 运行 recovery 与 extension 测试**

Run: `npm test -- test/fault-injection.test.ts test/extension.integration.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/recovery.ts src/pi-runtime.ts src/status-reporter.ts test/fault-injection.test.ts test/extension.integration.test.ts
git commit -m "feat: recover interrupted quarantine mutations"
```

### Task 8: Nested roots、并发压力、文档与最终验证

**Files:**
- Modify: `test/restore-engine.test.ts`
- Modify: `test/fault-injection.test.ts`
- Modify: `test/root-discovery.test.ts`
- Modify: `README.md`

- [ ] **Step 1: 增加 nested/submodule 和 Git metadata 回归测试**

```ts
it("outer、nested repo 和 initialized submodule 并发冲突均保留外部 bytes 与 Git metadata", async () => {
	const fixture = await nestedQuarantineFixture();
	const beforeMetadata = await Promise.all(fixture.roots.map(readGitMetadata));

	const result = await fixture.restoreWithExternalWriter("modules/child/file.txt", "external\n");

	expect(result.code).toMatch(/restore_failed_safe|recovery_required/);
	expect(await readFile(join(fixture.outer.root, "modules/child/file.txt"), "utf8")).toBe("external\n");
	expect(await Promise.all(fixture.roots.map(readGitMetadata))).toEqual(beforeMetadata);
});
```

增加 seeded 200 轮压力测试：随机选择 mutation ordinal 写入外部 bytes，结果必须是完整 target、完整 rollback，或 recovery lock 且所有版本仍存在。测试固定 seed，失败时打印 seed 和 ordinal，不使用时间竞争作为断言依据。

- [ ] **Step 2: 运行新增高风险测试**

Run: `npm test -- test/restore-engine.test.ts test/fault-injection.test.ts test/root-discovery.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 3: 更新 README**

在“数据与 Git 边界”和“明确限制”中写明：

```markdown
restore 对普通文件和 symlink 使用同文件系统 quarantine。目标安装采用 no-clobber 语义；外部进程在 restore 期间重建路径时，pi-undo 不覆盖该路径，并保留 transaction WAL 与可恢复 artifact。

quarantine 缩小但不能消除任意外部进程带来的竞态。无法证明 original、target 或 artifact 归属时，pi-undo 会进入 recovery required，而不是猜测或强制覆盖。
```

- [ ] **Step 4: 运行完整验证**

Run: `npm test -- --reporter=dot`

Expected: 所有测试文件通过，0 failed。

Run:

```bash
./node_modules/.bin/tsc --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --strict \
  --allowImportingTsExtensions \
  --types node,vitest/globals \
  src/atomic-fs.ts src/controller.ts src/encoding.ts src/git-runner.ts \
  src/journal.ts src/model.ts src/mutation-journal.ts src/path-safety.ts \
  src/quarantine.ts src/recovery.ts src/restore-engine.ts src/root-discovery.ts \
  src/session-state.ts src/snapshot-store.ts src/status-reporter.ts src/workspace-lock.ts
```

Expected: exit 0，无输出。

Run: `git diff --check`

Expected: exit 0，无输出。

Run: `npm_config_cache=/private/tmp/pi-undo-npm-cache npm pack --dry-run`

Expected: exit 0，tarball 只包含 package 发布文件，不包含 tests、resources、`.DS_Store` 或用户文件。

- [ ] **Step 5: 提交**

```bash
git add README.md test/restore-engine.test.ts test/fault-injection.test.ts test/root-discovery.test.ts
git commit -m "test: stress quarantine recovery across nested roots"
```

## 最终现场验证

在 `/private/tmp` 创建独立 outer repo、nested repo 和 initialized submodule，使用本机 Pi 完成一次真实 Agent run：

1. Agent 修改 outer 与 submodule 各一个文件。
2. `/undo` 的 mutation hook 阶段由外部 writer 修改其中一个文件。
3. 确认 Pi 返回 safe failure 或 recovery required，外部 bytes 未被覆盖。
4. 重启 session，确认 quarantine recovery 幂等。
5. 无冲突地重新执行 `/undo`、`/redo`，确认两个 root 内容正确。
6. 对比测试前后的 HEAD、index、refs、reflog、stash 和 config hash，必须完全一致。

如果真实 Pi reference package 尚未生成 `dist/index.d.ts`，必须如实记录完整 `npm run typecheck` 和真实 AgentSession build 未验证；不得用核心模块 typecheck 代替完整验证结论。
