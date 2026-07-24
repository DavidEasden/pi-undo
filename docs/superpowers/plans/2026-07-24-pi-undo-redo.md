# Pi Undo/Redo Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改用户 Git 元数据和 Pi 核心源码的前提下，为 Pi 0.80.10 构建可持久化、支持 nested repository/submodule 文件恢复的 `/undo` 与 `/redo` package。

**Architecture:** 根目录独立 Pi package 的 extension entry 只负责事件适配和 UI；`src/` 中的 controller、session state、journal、snapshot forest、restore engine 和 Git runner 通过明确接口协作。Pi session JSONL 的 cursor custom entry 与私有 Git manifest 共同形成边界，所有跨文件系统操作通过 workspace lock、WAL journal、救援快照和幂等 recovery 收敛。

**Tech Stack:** Node.js 22、TypeScript、Pi 0.80.10 Extension API、Vitest、Node `fs`/`crypto`/`child_process`、Git CLI、`proper-lockfile`。

---

## 文件布局与不变约束

实现只在仓库根目录创建以下 package 文件；禁止修改 `resources/pi-0.80.10/**`：

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
README.md
extensions/pi-undo.ts
src/model.ts
src/encoding.ts
src/atomic-fs.ts
src/git-runner.ts
src/path-safety.ts
src/workspace-lock.ts
src/root-discovery.ts
src/snapshot-store.ts
src/restore-engine.ts
src/journal.ts
src/session-state.ts
src/controller.ts
src/status-reporter.ts
test/fixtures.ts
test/model.test.ts
test/atomic-fs.test.ts
test/git-runner.test.ts
test/root-discovery.test.ts
test/snapshot-store.test.ts
test/restore-engine.test.ts
test/journal.test.ts
test/session-state.test.ts
test/controller.test.ts
test/extension.integration.test.ts
test/pi-session.integration.test.ts
```

每个任务结束后只提交该任务涉及的文件。测试需要读取 Pi 参考源码和使用临时 Git 仓库，但不向 `resources/pi-0.80.10/` 写入源码。

### Task 1: 初始化可安装的 Pi package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `extensions/pi-undo.ts`
- Create: `test/extension.integration.test.ts`

- [ ] **Step 1: 写 package manifest 和 TypeScript/Vitest 配置**

`package.json` 使用 Pi package manifest，runtime 依赖只包含锁实现，Pi 核心作为 peer：

```json
{
  "name": "pi-undo",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/pi-undo.ts"] },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.10"
  },
  "dependencies": {
    "proper-lockfile": "4.1.2"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "file:resources/pi-0.80.10/packages/coding-agent",
    "@types/node": "24.12.4",
    "@types/proper-lockfile": "4.1.4",
    "typescript": "5.9.3",
    "vitest": "4.1.9"
  }
}
```

`tsconfig.json` 必须允许 Pi 当前使用的 `.ts` extension import：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "extensions/**/*.ts", "test/**/*.ts"]
}
```

`vitest.config.ts` 使用 Node 环境、30 秒单测试超时和 `test/**/*.test.ts` include。

- [ ] **Step 2: 写最小 extension entry 的失败测试**

在 `test/extension.integration.test.ts` 中创建假的 `ExtensionAPI`，验证 default factory 注册恰好两个命令：

```ts
expect(commandNames).toEqual(["redo", "undo"]);
expect(commandDescriptions.get("undo")).toContain("last Agent run");
```

测试先失败，因为 `extensions/pi-undo.ts` 尚未注册命令。

- [ ] **Step 3: 实现最小 entry 并让 scaffold 测试通过**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "Undo the last completed Agent run",
		handler: async () => {},
	});
	pi.registerCommand("redo", {
		description: "Redo the last undone Agent run",
		handler: async () => {},
	});
}
```

- [ ] **Step 4: 安装依赖并运行 scaffold 验证**

Run: `npm install && npm test -- --reporter=dot`

Expected: extension scaffold test PASS；没有修改 `resources/pi-0.80.10` 源码。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts extensions/pi-undo.ts test/extension.integration.test.ts
git commit -m "chore: scaffold pi undo package"
```

### Task 2: 建立领域模型、canonical encoding 和 checksum

**Files:**
- Create: `src/model.ts`
- Create: `src/encoding.ts`
- Create: `test/model.test.ts`

- [ ] **Step 1: 写 manifest/checkpoint/cursor 的失败测试**

测试固定验证 key 排序、数组排序、Unicode/二进制字段的稳定编码，以及相同 payload 产生相同 SHA-256：

```ts
const a = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
const b = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
expect(a).toBe(b);
expect(checksum(a)).toBe(checksum(b));
```

同时验证无效 `schemaVersion`、重复 `opId` payload 和缺失 manifest ID 会抛出带稳定错误码的错误。

- [ ] **Step 2: 定义领域类型**

`src/model.ts` 至少提供以下类型，后续任务只能复用这些名称：

```ts
export type RootState = "active" | "uninitialized" | "broken";
export type ManifestId = string & { readonly __manifestId: unique symbol };
export type ResultCode =
	| "ok" | "noop" | "busy" | "idle_timeout" | "capture_failed"
	| "restore_failed_safe" | "partial_restore" | "recovery_required"
	| "history_paused" | "refill_skipped" | "refill_failed";

export interface SnapshotRoot {
	relativeRoot: string;
	parentRoot: string | null;
	state: RootState;
	sourceIdentity: string;
	privateRepositoryId: string;
	treeId: string | null;
	gitlinkOid?: string;
}

export interface SnapshotManifest {
	schemaVersion: 1;
	manifestId: ManifestId;
	workspaceIdentity: string;
	topologyFingerprint: string;
	coverage: string;
	roots: SnapshotRoot[];
	createdAt: string;
}

export interface CheckpointRecord {
	schemaVersion: 1;
	checkpointId: string;
	runId: string;
	startEntryId: string;
	userEntryId: string;
	endLeafId: string;
	rawPrompt: string;
	beforeManifestId: ManifestId;
	afterManifestId: ManifestId;
	changedPaths: string[];
	checksum: string;
}

export interface CursorState {
	schemaVersion: 1;
	opId: string;
	action: "undo" | "redo" | "tree";
	fromLogicalLeaf: string | null;
	toLogicalLeaf: string | null;
	targetManifestId: ManifestId;
	rollbackManifestId: ManifestId;
	undoHead: string | null;
	redoStack: string[];
	descriptorChecksum: string;
	checksum: string;
}
```

补充 `JournalPhase`、`OperationDescriptor`、`RestorePath`、`TopologyFingerprint` 和 `WorkspaceFingerprint`，所有字段都不可变或明确标注 mutable。

- [ ] **Step 3: 实现 canonical JSON、checksum 和 schema guard**

`src/encoding.ts` 导出：

```ts
export function canonicalJson(value: unknown): string;
export function checksum(value: string | Uint8Array): string;
export function assertManifest(value: unknown): SnapshotManifest;
export function assertCursor(value: unknown): CursorState;
```

校验必须拒绝未知 schema version、绝对路径、非规范 root 顺序和 checksum 不匹配。

- [ ] **Step 4: 运行模型测试**

Run: `npm test -- test/model.test.ts --reporter=dot`

Expected: canonical encoding、schema guard、checksum 和非法数据测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/encoding.ts test/model.test.ts
git commit -m "feat: add undo snapshot domain model"
```

### Task 3: 实现原子文件、Git runner 和路径安全边界

**Files:**
- Create: `src/atomic-fs.ts`
- Create: `src/git-runner.ts`
- Create: `src/path-safety.ts`
- Create: `test/atomic-fs.test.ts`
- Create: `test/git-runner.test.ts`

- [ ] **Step 1: 写 Git runner 和 atomic file 的失败测试**

测试覆盖：非零退出、`killed=true`、超时、AbortSignal、stderr 截断、临时文件残留、rename 后 checksum 校验；同时验证命令参数不经过 shell 拼接。

```ts
const result = await runner.run(["-C", tempRoot, "status", "--porcelain"]);
expect(result.code).toBe(0);
expect(result.killed).toBe(false);
await expect(runner.run(["--definitely-invalid"])).rejects.toMatchObject({ code: "git_failed" });
```

- [ ] **Step 2: 定义并实现 `GitRunner`**

```ts
export interface GitRunOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
}

export interface GitRunner {
	run(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult>;
}
```

使用 `spawn("git", args, { shell: false })`，所有返回值必须检查 `code` 和 `killed`，不要把 stdout 非空当作成功。

- [ ] **Step 3: 实现 `atomic-fs.ts`**

导出：

```ts
export async function writeJsonAtomic(file: string, value: unknown): Promise<void>;
export async function writeBytesAtomic(file: string, bytes: Uint8Array, mode?: number): Promise<void>;
export async function fsyncFile(file: string): Promise<void>;
export async function fsyncDirectory(directory: string): Promise<void>;
```

写入流程固定为同目录临时文件、完整写入、fsync、rename、父目录 fsync；内容寻址文件若已存在只比较字节，不覆盖。

- [ ] **Step 4: 实现 `path-safety.ts`**

```ts
export function relativeSafePath(root: string, candidate: string): string;
export function assertNoSymlinkEscape(root: string, relativePath: string): Promise<void>;
export function sortDeletePaths(paths: readonly string[]): string[];
export function sortWritePaths(paths: readonly string[]): string[];
```

拒绝绝对路径、`..` 穿越、NUL、root 外 canonical path 和中途 symlink；删除排序按深度降序，写回排序按深度升序。

- [ ] **Step 5: 运行底层测试并提交**

Run: `npm test -- test/atomic-fs.test.ts test/git-runner.test.ts --reporter=dot`

Expected: 退出码、超时、abort、fsync/rename、路径越界和 symlink escape 测试 PASS。

```bash
git add src/atomic-fs.ts src/git-runner.ts src/path-safety.ts test/atomic-fs.test.ts test/git-runner.test.ts
git commit -m "feat: add safe git and atomic filesystem primitives"
```

### Task 4: 实现 workspace lock 和 root discovery

**Files:**
- Create: `src/workspace-lock.ts`
- Create: `src/root-discovery.ts`
- Create: `test/fixtures.ts`
- Create: `test/root-discovery.test.ts`

- [ ] **Step 1: 写本地 Git fixture 和 discovery 失败测试**

`test/fixtures.ts` 提供 `createGitRepo()`、`createNestedRepo()`、`createLocalSubmodule()`、`writeFile()` 和 `readGitMetadata()`，所有仓库都在 `mkdtemp` 下创建。测试先覆盖：

- Git root、非 Git synthetic root、两层 nested root；
- initialized/uninitialized/broken submodule；
- 父 ignore 不隐藏 child，child ignore 仍生效；
- symlink 目录不被跟随，canonical root 去重；
- topology fingerprint 在新增/删除 `.git` 或 gitlink 后变化。

- [ ] **Step 2: 实现跨进程 `WorkspaceLock`**

```ts
export interface WorkspaceLock {
	withLock<T>(workspaceIdentity: string, fn: () => Promise<T>): Promise<T>;
}
```

使用 `proper-lockfile` 或等价 mkdir lease，lock payload 包含 PID、process start time、workspace identity 和随机 nonce；检测 stale lock 时只能在 owner 已不存在且 lease 超时后清理。进程内另设按 workspace identity 的 promise mutex。

- [ ] **Step 3: 实现 `RootDiscovery`**

```ts
export interface RootTopology {
	workspaceIdentity: string;
	roots: SnapshotRoot[];
	fingerprint: string;
}

export interface RootDiscovery {
	discover(workspaceRoot: string): Promise<RootTopology>;
}
```

实现受控 `.git` 扫描、gitlink 只读读取、`rev-parse` 验证、synthetic root、最深 root ownership、uninitialized/broken 状态和前后 fingerprint。父 root discovery 必须绕过父 ignore，capture 阶段再按各 root 自己的 ignore 规则过滤文件。

- [ ] **Step 4: 运行 discovery 测试**

Run: `npm test -- test/root-discovery.test.ts --reporter=dot`

Expected: Git、非 Git、nested、submodule、ignore、symlink、stale lock 和 topology retry 测试 PASS；每个测试清理临时目录。

- [ ] **Step 5: Commit**

```bash
git add src/workspace-lock.ts src/root-discovery.ts test/fixtures.ts test/root-discovery.test.ts
git commit -m "feat: discover nested roots with workspace locking"
```

### Task 5: 实现私有 SnapshotStore 和 federated manifest

**Files:**
- Create: `src/snapshot-store.ts`
- Create: `test/snapshot-store.test.ts`

- [ ] **Step 1: 写 capture/对象自包含测试**

测试首先断言以下行为失败或不产生 manifest：broken root、topology 前后 fingerprint 不一致、Git 命令失败、空 tree、ignored 查询失败、对象 materialize 失败、coverage 不完整。成功 fixture 必须包含 tracked、untracked、binary、5 MiB 文件、symlink 和 nested root。

- [ ] **Step 2: 定义 SnapshotStore 接口**

```ts
export interface SnapshotStore {
	capture(topology: RootTopology, scope?: readonly string[]): Promise<SnapshotManifest>;
	loadManifest(id: ManifestId): Promise<SnapshotManifest>;
	assertComplete(id: ManifestId): Promise<void>;
	listTree(id: ManifestId, root: string): Promise<readonly RestorePath[]>;
	pin(id: ManifestId, reason: string): Promise<void>;
	unpin(id: ManifestId, reason: string): Promise<void>;
}
```

`RestorePath` 至少包含 `relativePath`、`kind`、`mode`、`blobId`、`size` 和 `rootHash`；symlink 保存 link text，目录只作为骨架信息。

- [ ] **Step 3: 实现私有 Git root capture**

每个 root 的 capture 必须：创建/复用 store 私有 `GIT_DIR`，使用事务专属临时 index，读取 `.gitignore` 但不修改用户 index，排除 descendant root，执行 staging/write-tree，验证 tree/blob 闭包，生成 root entry。临时 root capture 失败时不发布 manifest。

- [ ] **Step 4: 实现 manifest 发布、pin 和 GC 标记**

canonical serialize forest manifest，以 SHA-256 生成 `ManifestId`，先写 immutable manifest 再写 pin；活动 store 不触发 GC。GC 只扫描没有 session/cursor/journal 引用且超过 7 天的 pin，清理失败只记录 cleanup pending。

- [ ] **Step 5: 验证私有对象不依赖真实 object database**

capture 后暂时把真实仓库 object database 移到 fixture 外或通过环境隔离，调用 `assertComplete()` 和 `listTree()`；断言目标 blob 仍可读取。验证真实 HEAD、index、refs、reflog 内容与 capture 前完全相同。

- [ ] **Step 6: 运行测试并提交**

Run: `npm test -- test/snapshot-store.test.ts --reporter=dot`

Expected: 私有 store、non-Git synthetic root、large file、ignore、nested forest、对象自包含、pin 和失败不发布测试 PASS。

```bash
git add src/snapshot-store.ts test/snapshot-store.test.ts
git commit -m "feat: capture self-contained snapshot forests"
```

### Task 6: 实现 set-state RestoreEngine

**Files:**
- Create: `src/restore-engine.ts`
- Create: `test/restore-engine.test.ts`

- [ ] **Step 1: 写 restore plan 和故障注入测试**

测试先固定计划顺序和 invariants：

```ts
expect(plan.deletePaths).toEqual(["child/deep.txt", "child"]);
expect(plan.writePaths).toEqual(["app", "child/deep.txt"]);
expect(plan.touchedPaths.every((p) => p.startsWith("app/") || p.startsWith("child/"))).toBe(true);
```

在第 `k` 个文件写入时注入异常，断言 rollback manifest 能恢复 pre-state；rollback 再失败时结果只能是 `partial_restore`/`recovery_required`。

- [ ] **Step 2: 定义 RestoreEngine 接口**

```ts
export interface RestorePlan {
	currentManifestId: ManifestId;
	targetManifestId: ManifestId;
	boundaryRoots: string[];
	deletePaths: string[];
	writePaths: string[];
	planDigest: string;
}

export interface RestoreResult {
	code: "ok" | "restore_failed_safe" | "partial_restore" | "recovery_required";
	verifiedPaths: number;
	totalPaths: number;
	postFingerprint?: string;
}

export interface RestoreEngine {
	plan(current: SnapshotManifest, target: SnapshotManifest): Promise<RestorePlan>;
	apply(plan: RestorePlan, target: SnapshotManifest): Promise<RestoreResult>;
}
```

- [ ] **Step 3: 实现 deepest-first 删除和 shallowest-first 写回**

使用 `current roots ∪ target roots` 作为 boundary；每个普通文件同目录 temp、写入、fsync、rename；写入前重新检查路径组件，拒绝 symlink escape。真实 `.git`、ignored 文件和 boundary 外文件不触碰。文件 mode、symlink target、删除和新增 root 必须按 manifest set-state 处理。

- [ ] **Step 4: 实现 post-state fingerprint 和 topology 校验**

恢复完成后重新 discovery、读取 selected scope，比较目标内容、mode、symlink、root identity、topology 和 coverage；任一不等即失败，不移动 cursor。

- [ ] **Step 5: 运行 restore 测试并提交**

Run: `npm test -- test/restore-engine.test.ts --reporter=dot`

Expected: nested boundary、binary/large file、mode/symlink、ignored/.git 保留、partial restore、rollback 和外部 drift 测试 PASS。

```bash
git add src/restore-engine.ts test/restore-engine.test.ts
git commit -m "feat: restore workspace state by manifest"
```

### Task 7: 实现 WAL Journal、durable cursor marker 和 recovery

**Files:**
- Create: `src/journal.ts`
- Create: `test/journal.test.ts`

- [ ] **Step 1: 写每个 journal phase 的故障测试**

测试在 `PREPARING`、`PREPARED`、`SESSION_MOVED`、`APPLYING`、`FILES_VERIFIED`、cursor append 前后和 `COMMITTED` 前后模拟进程退出；每次重启 recovery 两次，结果必须相同。

- [ ] **Step 2: 定义 journal API**

```ts
export type JournalPhase =
	| "PREPARING" | "PREPARED" | "SESSION_MOVED" | "APPLYING"
	| "FILES_VERIFIED" | "CURSOR_COMMITTED" | "COMMITTED"
	| "ABORTING" | "ABORTED" | "RECOVERY_REQUIRED";

export interface JournalStore {
	prepare(descriptor: OperationDescriptor): Promise<void>;
	setPhase(opId: string, phase: JournalPhase): Promise<void>;
	loadPending(): Promise<readonly OperationDescriptor[]>;
	markCommitted(opId: string): Promise<void>;
	removeIfSettled(opId: string): Promise<void>;
}

export interface RecoveryDecision {
	action: "rollback" | "roll_forward" | "lock" | "discard";
	reason: string;
}
```

- [ ] **Step 3: 实现 descriptor/state/plan 原子写入**

descriptor 和 restore plan immutable；state 包含 revision、descriptor checksum、phase checksum。每次 state 更新执行 temp/fsync/rename/parent-dir fsync。绝不覆盖内容寻址 manifest。

- [ ] **Step 4: 实现 cursor marker 判定**

从 Pi session JSONL 读取完整 newline-terminated custom entry，验证 `customType === "pi-undo:cursor"`、schema、operationId、descriptor checksum 和 payload checksum；torn line 不算 commit，完整相同 opId 只算一次，不同 payload 进入 lock。

- [ ] **Step 5: 实现 recovery decision table**

无有效 cursor marker 时 rollback 并校验；有 marker 时 roll-forward target 并校验；manifest/JSONL/journal 不一致时返回 `lock`。recovery 结果必须写 phase 并可重复执行。

- [ ] **Step 6: 运行 journal 测试并提交**

Run: `npm test -- test/journal.test.ts --reporter=dot`

Expected: atomic state、torn JSONL、duplicate opId、rollback/forward、二次 recovery 和 recovery lock 测试 PASS。

```bash
git add src/journal.ts test/journal.test.ts
git commit -m "feat: add undo transaction journal and recovery"
```

### Task 8: 实现 Pi session branch state 和 durable entry 适配

**Files:**
- Create: `src/session-state.ts`
- Create: `test/session-state.test.ts`

- [ ] **Step 1: 写 session branch projection 测试**

用 `SessionManager.inMemory()` 和临时 JSONL session 构造 user/assistant/tool/custom/cursor entries，断言 `pi-undo:*` entry 不进入 LLM branch context，cursor parent 才是 logical leaf，旧分支 checkpoint 不被删除。

- [ ] **Step 2: 定义 SessionState API**

```ts
export interface SessionState {
	getActiveBranch(): readonly SessionEntry[];
	getCheckpoints(): readonly CheckpointRecord[];
	getCursor(): CursorState | null;
	getLogicalLeafId(): string | null;
	findUserEntry(checkpointId: string): string;
	findTargetManifest(targetId: string): Promise<ManifestId>;
}

export interface DurableCursorWriter {
	appendCursor(state: CursorState, pi: ExtensionAPI, manager: ReadonlySessionManager): Promise<void>;
}
```

- [ ] **Step 3: 实现 active branch projection**

从 `getBranch()` 过滤 package custom entries；忽略 cursor/start/checkpoint/barrier 的消息语义；校验 checkpoint parent chain、run ID、manifest completeness 和 current branch generation。非法记录不静默加入 undo stack。

- [ ] **Step 4: 实现 durable cursor writer**

调用 `pi.appendEntry("pi-undo:cursor", data)` 后读取 `getSessionFile()`，确认完整 JSONL 行包含 opId/checksum，再 `fsyncFile()`；append ambiguous 时交给 JournalRecovery，不声称成功。Pi API 没有返回 entry ID，因此从当前 leaf 和 session entries 回读生成验证。

- [ ] **Step 5: 运行 session 测试并提交**

Run: `npm test -- test/session-state.test.ts --reporter=dot`

Expected: branch projection、cursor transparency、restart parse、torn line、durable marker 和 stale generation 测试 PASS。

```bash
git add src/session-state.ts test/session-state.test.ts
git commit -m "feat: persist undo state in pi session branches"
```

### Task 9: 实现 UndoController 的输入 gate、checkpoint 和操作状态机

**Files:**
- Modify: `extensions/pi-undo.ts`
- Create: `src/controller.ts`
- Create: `test/controller.test.ts`

- [ ] **Step 1: 写 controller 的失败测试**

使用 fake `SnapshotStore`、`RestoreEngine`、`JournalStore`、`SessionState` 和 command context，先固定这些场景：

- `undo`/`redo` 无可用项是 noop，不调用 capture/restore；
- agent active 时 abort、等待 idle，超时前 capture/restore 调用次数为 0；
- safety capture 失败不 pop/push stack；
- restore 第 `k` 个路径失败且 rollback 成功时 stack/session/workspace 回到旧状态；
- rollback 失败时返回 recovery_required 并阻止下一次 prompt；
- 新 prompt 在 before hook 清 redo，旧 branch 保留；
- after capture 失败写 barrier，下一次成功 baseline 清理旧 frontier。

- [ ] **Step 2: 定义 controller 依赖接口**

```ts
export interface ControllerDependencies {
	store: SnapshotStore;
	restore: RestoreEngine;
	journal: JournalStore;
	session: SessionState;
	lock: WorkspaceLock;
	clock: () => number;
}

export interface OperationResult {
	code: ResultCode;
	changedFiles: number;
	message?: string;
}

export interface UndoController {
	prepareInput(text: string, ctx: ExtensionContext): Promise<InputEventResult>;
	beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void>;
	agentSettled(ctx: ExtensionContext): Promise<void>;
	undo(ctx: ExtensionCommandContext): Promise<OperationResult>;
	redo(ctx: ExtensionCommandContext): Promise<OperationResult>;
	beforeTree(event: SessionBeforeTreeEvent, ctx: ExtensionContext): Promise<SessionBeforeTreeResult | undefined>;
	afterTree(event: SessionTreeEvent, ctx: ExtensionContext): Promise<void>;
	recover(ctx: ExtensionContext): Promise<void>;
}
```

- [ ] **Step 3: 实现 input gate 和 normal run lifecycle**

idle input 获取 lock、capture before manifest、保存 raw prompt；streaming input 不新建 boundary。capture 失败返回 `{ action: "handled" }` 并把输入保留在 TUI editor。`beforeAgentStart` 只在 staged baseline 存在时追加 start entry；新 branch 此时清 redo。`agentSettled` capture after、计算 changedPaths、追加 checkpoint；失败写 history barrier。

- [ ] **Step 4: 实现 `/undo` 和 `/redo` saga**

每个命令执行 `busy -> stopping -> capturing -> restoring -> committing -> ready` 状态；用 `Promise.race` 实现 30 秒 idle deadline。严格执行 PREPARED、SESSION_MOVED、APPLYING、FILES_VERIFIED、CURSOR_COMMITTED 顺序；只有 durable cursor marker 后推进 stack。command path 的 restore/commit 失败使用 source logical leaf 和 rollback manifest 补偿。

- [ ] **Step 5: 实现 `/tree` 协调和 recovery lock**

streaming 时 `session_before_tree` 调用 abort 并返回 cancel；idle 后用户重试。正常 tree 预检并建立 rescue journal，`session_tree` 后恢复目标 boundary；事件上下文无法反向导航时保留 journal、锁住新 prompt 并等待 recovery。summary cancel 保证没有文件 mutation。

- [ ] **Step 6: 运行 controller 测试并提交**

Run: `npm test -- test/controller.test.ts --reporter=dot`

Expected: normal lifecycle、undo/redo、abort deadline、barrier、branch invalidation、tree cancel、compensation 和 recovery lock 测试 PASS。

```bash
git add src/controller.ts extensions/pi-undo.ts test/controller.test.ts
git commit -m "feat: orchestrate undo redo transactions"
```

### Task 10: 实现 StatusReporter 和完整 Extension API 绑定

**Files:**
- Create: `src/status-reporter.ts`
- Modify: `extensions/pi-undo.ts`
- Modify: `test/extension.integration.test.ts`

- [ ] **Step 1: 写 UI mode 测试**

验证单一 footer key `pi-undo` 的 ready/busy/capturing/restoring/history_paused/recovery_required 状态，notify 结果码和单行 sanitize。TUI editor 为空时写回并 read-back；editor 非空、RPC、print/json 分别得到 skipped/requested/unsupported。

- [ ] **Step 2: 实现 `StatusReporter`**

```ts
export interface StatusReporter {
	setReady(undoCount: number, redoCount: number): void;
	setPhase(text: string): void;
	setRecoveryRequired(reason: string): void;
	clear(): void;
	result(result: OperationResult): void;
}
```

所有 footer 文本保持单行和短长度；stderr、绝对路径、token 和控制字符经过 sanitize 后才可进入 notify。

- [ ] **Step 3: 完成 extension entry 的事件绑定**

`extensions/pi-undo.ts` 创建 controller/store/status，注册 `/undo`、`/redo`，绑定 `input`、`before_agent_start`、`agent_settled`、`session_start`、`session_before_tree`、`session_tree`、`session_shutdown`。session_start 恢复 journal、重建 branch state、重设 footer；session replacement/reload 后不使用 stale context。

- [ ] **Step 4: 运行 extension integration 测试并提交**

Run: `npm test -- test/extension.integration.test.ts --reporter=dot`

Expected: command registration、event binding、status reset、TUI/RPC/print behavior、stale context 和 notify code 测试 PASS。

```bash
git add src/status-reporter.ts extensions/pi-undo.ts test/extension.integration.test.ts
git commit -m "feat: bind pi commands lifecycle and status"
```

### Task 11: 使用真实 Pi AgentSession 完成集成测试

**Files:**
- Create: `test/pi-session.integration.test.ts`
- Modify: `test/fixtures.ts`

- [ ] **Step 1: 准备 Pi 0.80.10 测试运行时**

在实现 package 的工作区安装 Pi reference 依赖并构建其四个 workspace package：

```bash
npm --prefix resources/pi-0.80.10 install
npm --prefix resources/pi-0.80.10 run build
npm install
```

Expected: `resources/pi-0.80.10/packages/{agent,ai,tui,coding-agent}/dist` 生成；不修改这些目录的源码。

- [ ] **Step 2: 写真实 AgentSession 测试 fixture**

使用 Pi 现有 `registerFauxProvider()`、`createAgentSessionRuntime()` 和临时 workspace，提供可控响应和可控 tool hook；每个测试显式 `await session.agent.waitForIdle()`，结束时释放 runtime、provider、workspace lock 和临时目录。

- [ ] **Step 3: 写并运行正常路径集成测试**

覆盖两个 run 的 before/after manifest、`/undo`、`/redo`、手动改动、new prompt 清 redo、旧 branch `/tree`、prompt refill、session restart。断言每次成功消息前已完成 manifest fingerprint 和 cursor marker 校验。

Run: `npm test -- test/pi-session.integration.test.ts --reporter=dot`

Expected: TUI-compatible fake UI 下 normal undo/redo、restart 和 branch 测试 PASS。

- [ ] **Step 4: 加入 streaming、summary 和 queue 场景**

使用延迟 faux provider/tool，验证运行中 `/undo` 先 abort 后等待，工具未停止时没有 restore；`/tree` streaming 被取消；summary abort 不改变 session entries/leaf/workspace；TUI queue 文本不会被 prompt refill 覆盖。

- [ ] **Step 5: 加入 nested Git 验收场景**

创建 outer repo、两层 nested repo、initialized local submodule、uninitialized gitlink 和 broken path；运行 Agent 写入 child dirty/untracked、删除/新增 root、修改大文件。undo/redo 后逐个比较工作区 fingerprint，并比较每个真实 root 的 HEAD、index、refs、reflog 和 `.git` 内容 hash。

- [ ] **Step 6: Commit**

```bash
git add test/fixtures.ts test/pi-session.integration.test.ts
git commit -m "test: cover pi session undo redo integration"
```

### Task 12: 补齐故障注入、crash recovery 和跨进程测试

**Files:**
- Create: `test/fault-injection.test.ts`
- Modify: `test/journal.test.ts`
- Modify: `test/controller.test.ts`
- Modify: `test/fixtures.ts`

- [ ] **Step 1: 写 capture/restore fault adapter**

提供可控 fault adapter：`failCaptureAt(rootIndex)`, `failRestoreAt(pathIndex)`, `failRollback()`, `failCursorAppend(mode)`, `writeTornJsonlLine()`, `changeTopologyDuringCapture()` 和 `killAfter(phase)`。fault 必须通过依赖接口注入，不能修改 Pi reference 源码。

- [ ] **Step 2: 验证失败前后的 invariants**

每个 fault 记录并比较：workspace fingerprint、topology fingerprint、active logical leaf、undo head、redo stack、journal generation、footer phase。capture/safety/idle 失败时所有值不变；rollback 成功时回到 pre-op；rollback 失败时只有 recovery_required 合法。

- [ ] **Step 3: 验证 cursor marker 和 restart**

在每个 journal phase 后重建 controller/session state，断言没有 marker 时 rollback，有 marker 时 roll-forward，相同 opId recovery 两次不重复移动 stack，冲突 payload 进入 lock。

- [ ] **Step 4: 验证跨进程 workspace lock**

启动两个 Node worker 共享同一 workspace identity：第一个持锁并阻塞 restore，第二个必须得到 busy/lock timeout 且没有 capture/restore；owner 退出后 stale lease 只在 lease 超时并确认 PID 不存在时清理。

- [ ] **Step 5: 运行完整故障测试并提交**

Run: `npm test -- test/fault-injection.test.ts test/journal.test.ts test/controller.test.ts --reporter=dot`

Expected: 所有 phase kill、torn JSONL、partial restore、rollback、duplicate recovery、lock conflict 测试 PASS。

```bash
git add test/fault-injection.test.ts test/journal.test.ts test/controller.test.ts test/fixtures.ts
git commit -m "test: exercise undo recovery failure paths"
```

### Task 13: 完善 package 文档、安装说明和发布检查

**Files:**
- Create: `README.md`
- Modify: `package.json`

- [ ] **Step 1: 写 README 验收内容**

README 必须包含：

- `pi install ./path/to/pi-undo` 和 `pi -e ./extensions/pi-undo.ts` 本地试用命令；
- `/undo`、`/redo`、`/tree` 的行为和 streaming 约束；
- package 私有 store 不在项目创建 `.git`，不需要用户 commit/stash；
- nested repository/submodule 只恢复内部工作区文件，不切换真实 Git metadata；
- ignored、真实 `.git`、外部并发写入、`--no-session` 和 recovery lock 的明确限制；
- 故障时 `recovery required` 的排查路径和 journal 保留策略。

- [ ] **Step 2: 完善 npm scripts 和 package files**

加入 `typecheck`、`test:integration` 和 `pack:dry-run`，`files` 只包含 `extensions`、`src`、`README.md`、`package.json` 和发布所需 lockfile；不要把 `resources/pi-0.80.10`、测试临时目录或 `.pi-undo` 打包。

- [ ] **Step 3: 运行 package 发布检查**

Run:

```bash
npm run typecheck
npm test -- --reporter=dot
npm pack --dry-run
```

Expected: TypeScript 无错误、所有单元/集成测试通过，dry-run 列表不包含 `resources/`、`.DS_Store`、测试产物或用户工作区文件。

- [ ] **Step 4: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: document pi undo package installation"
```

### Task 14: 最终验收与交付前审查

**Files:**
- Modify only if verification finds a concrete defect: `src/**/*.ts`, `extensions/pi-undo.ts`, `test/**/*.test.ts`, `README.md`

- [ ] **Step 1: 运行完整验证命令**

```bash
npm run typecheck
npm test -- --reporter=dot
npm pack --dry-run
git diff --check HEAD~14..HEAD
```

Expected: typecheck/test/dry-run 成功；Git diff 无 whitespace error；`resources/pi-0.80.10/**` 没有源码 diff。

- [ ] **Step 2: 手工 smoke test package loading**

在临时 Pi project 中运行：

```bash
pi -e /absolute/path/to/pi-undo/extensions/pi-undo.ts
```

验证启动 footer、`/undo`、`/redo`、无 checkpoint 的 noop、非 Git workspace 和 restart 后状态；在用户 Git fixture 上比较 HEAD/index/refs 前后值。

- [ ] **Step 3: 做 spec-to-plan 覆盖审查**

逐项确认：私有对象库和无 alternates（Task 5）、nested forest/submodule（Tasks 4/5/11）、set-state restore（Task 6）、WAL/recovery（Task 7/12）、Pi lifecycle/UI（Tasks 9/10/11）、大文件/ignored/metadata（Tasks 5/6/11）、restart/no-session（Tasks 7/11/13）。发现缺失时先补测试和实现任务，再报告完成。

- [ ] **Step 4: 交付前保持工作区边界**

确认最终 diff 只包含 package、tests、README 和本设计/计划文档；不清理、不重置用户已有的 `hello-bad.md`、`.DS_Store` 或 `resources/` 变更。

