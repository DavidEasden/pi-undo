# Pi Undo/Redo Package 设计说明

日期：2026-07-24
状态：设计已通过分节确认，尚未进入实现

## 1. 背景与目标

为 Pi 0.80.10 创建一个 package，使 Pi 获得类似 OpenCode 的 undo/redo 能力：用户可以用 `/undo` 和 `/redo` 回退或恢复一个完整 Agent run，同时回退或恢复 Pi 会话树位置和工作区文件。用户不需要执行 Git 命令，也不需要理解或维护任何 Git 分支、commit、stash 或 ref。

本设计只增加 Pi 扩展 package，不修改 Pi 核心源码。实现必须遵守 Pi 0.80.10 的公开扩展 API，并明确 API 无法提供的原子性边界。

### 1.1 已确认目标

- UI 只提供 `/undo`、`/redo` 和 footer 状态，不增加独立的可视化面板。
- 一次 undo 回退一个完整 Agent run。run 以 `agent_settled` 为结束边界，包含自动重试、自动压缩以及已经排空的 follow-up 队列。
- Pi 重启后保留 undo/redo 状态。
- 非 Git 项目自动启用私有 Git 对象库，项目目录中不创建 `.git`。
- 快照覆盖所有 Git 可见的非 ignored 文件，包括未跟踪文件、二进制文件和大型文件。
- 每次 undo/redo 前保存当前工作区状态，redo 可以恢复这一步操作前的用户手动修改。
- undo 后输入新 prompt 会创建新的会话分支并使普通 redo 失效；旧分支及其快照仍可通过 `/tree` 访问。
- Agent 运行中执行 `/undo` 时先 abort，再等待 idle；工具尚未停止前绝不恢复文件。
- undo 后把原始用户 prompt 写回编辑器；如果 TUI 中已有排队文本或用户新输入，不覆盖已有文本。
- 嵌套仓库和 submodule 完整支持内部工作区文件恢复，但不修改真实 `HEAD`、index、refs、reflog、stash 或其他 Git 元数据。

### 1.2 非目标与明确边界

- 不恢复或重建真实 Git 元数据。被删除的真实 `.git` 不会由 package 重建。
- 不纳入 ignored 文件、空目录以及工作区之外的 Git 元数据。
- 不保证任意外部编辑器、watcher 或其他进程同时写入时的操作系统级隔离；package 只能锁住自己管理的操作。
- 不承诺跨 Pi session JSONL、私有 store 和任意工作区文件系统的真正 ACID 事务。承诺是 Pi 恢复后可确定地回滚到旧状态或向前补完新状态。
- `--no-session` 模式没有持久化会话 cursor；严格模式下只提供进程内能力，不能宣称崩溃后持久化。

## 2. 现有实现约束

### 2.1 OpenCode 参考行为

OpenCode 1.18.4 的快照仅在已有 Git 仓库中启用，使用私有 snapshot 逻辑保存工作区状态；undo/redo 本质上是一个 session revert 边界，而不是独立的栈。新 prompt 会清除被隐藏尾部，因此旧分支不会继续作为普通 redo 使用。它对新建且大于 2 MiB 的未跟踪文件还有静默跳过行为，并不能恢复嵌套仓库内部的 dirty 文件。

本 package 保留 OpenCode 的“文件快照和会话边界绑定”思想，但改为 Pi 会话树加私有 Git tree，并明确扩大到非 Git 项目、大文件和嵌套仓库文件层。

### 2.2 Pi 0.80.10 公开 API 限制

研究依据包括：

- `ExtensionCommandContext` 提供 `abort()`、`waitForIdle()`、`navigateTree()`，但 command handler 没有结构化返回值。
- `input` 事件可以返回 `handled`，而 `before_agent_start` handler 出错会被 extension runner 记录后继续运行，不能取消本轮 Agent。
- `agent_settled` 比 `agent_end` 更适合作为完整 run 边界。
- `session_before_tree` 可以取消导航，`session_tree` 只能在导航完成后收到通知；事件上下文没有反向导航的 command API。
- `SessionManager` 是 append-only JSONL tree，普通 `branch()` 和 `resetLeaf()` 只修改内存 leaf，不单独持久化；`appendEntry()` 先更新内存再写文件，且 Pi 本身不提供 fsync 确认。
- `setStatus()`、`notify()` 和 `setEditorText()` 均为 void；RPC 与 print/json 模式不能证明 UI 已执行。

因此 package 需要自行实现 workspace lock、私有 store、WAL journal、路径恢复、JSONL entry 回读和 recovery lock，但不能把这些包装成 Pi 原生跨资源事务。

## 3. 方案比较与选型

### 3.1 方案 A：直接使用用户 Git 仓库

每次 Agent run 创建 commit、stash 或隐藏 branch，undo/redo 通过 reset、checkout 或 stash apply 完成。

优点是 Git 能处理大量文件、rename 和二进制，开发量较小。缺点是会修改用户的 `.git`、index、refs、reflog，容易与用户正在进行的 Git 操作冲突；非 Git 项目、嵌套仓库和 submodule 的语义也不一致。该方案不采用。

### 3.2 方案 B：Pi 会话树加私有 Git snapshot forest（采用）

Pi session tree 保存“回到哪一个会话边界”，私有 Git object store 保存“文件应该是什么”。普通项目和每个 nested repository 都拥有独立的私有 `GIT_DIR`、临时 index 和 tree，所有 root 组成一个 federated manifest。undo/redo 通过 checkpoint 和 cursor custom entry 绑定两者。

该方案不触碰用户 Git 元数据，Git 的内容寻址和 deduplication 仍然可用，并能精确表达 nested root 的文件边界。代价是需要实现 root discovery、恢复顺序、journal 和 crash recovery。

### 3.3 方案 C：纯文件复制或自定义 patch archive

每个边界复制文件或保存自定义 diff，不依赖 Git。

优点是可完全控制元数据范围，不需要 Git CLI。缺点是 rename、symlink、executable bit、嵌套 root、对象去重、大文件和中断恢复都需要重新实现；长期存储和并发恢复复杂度高于私有 Git tree。该方案不采用。

## 4. 总体架构

package 由以下逻辑组件组成，每个组件只负责一个边界：

1. `ExtensionAdapter`：注册 `/undo`、`/redo`，订阅 `input`、`before_agent_start`、`agent_settled`、`session_start`、`session_before_tree`、`session_tree`，并维护 footer/notify。
2. `UndoController`：维护活动分支上的 checkpoint、undo head、redo stack 和 operation mutex，协调会话导航与文件恢复。
3. `BoundaryResolver`：从当前 Pi session tree 找到最近的完整 checkpoint，并把 user/non-user tree target 映射为逻辑 cursor 和目标 manifest。
4. `RootDiscovery`：发现父仓库、nested repository 和 submodule worktree，生成稳定 topology fingerprint。
5. `SnapshotStore`：为每个 root 建立私有 Git object database、临时 index、tree 和 federated manifest，保证对象自包含。
6. `RestoreEngine`：按 current/target root 并集生成 set-state restore plan，执行删除、写回和验证。
7. `JournalRecovery`：以 WAL descriptor/state/plan 记录跨 session JSONL 和工作区的可补偿事务，在启动和命令前完成恢复。
8. `WorkspaceLock`：对 canonical workspace 和 store 实施进程内及跨进程互斥，阻止两个 Pi session 同时恢复同一工作区。
9. `StatusReporter`：使用单一 `pi-undo` footer key，向 TUI、RPC、print/json 映射稳定结果码。

组件之间只通过 manifest ID、checkpoint ID、operation ID 和逻辑 cursor 通信，不直接共享长期可变 Git index。

## 5. 私有存储与对象生命周期

### 5.1 路径布局

私有数据放在 Pi session 数据目录，不进入项目工作区：

```text
<sessionDir>/.pi-undo/
  stores/<storeId>/
    manifests/<manifestId>.json
    roots/<rootHash>/git/
    pins/<manifestId>.json
    transactions/<opId>/
      descriptor.json
      state.json
      restore-plan.json
```

`storeId` 由 canonical workspace identity、Pi package schema version 和根仓库 source identity 派生，不能把另一项目或另一版本的 store 接入当前 session。

### 5.2 自包含对象

每个私有 Git object database 必须拥有目标 tree/blob 的完整对象闭包，不使用指向真实仓库 objects 的 alternates。发布 manifest 前验证所有 tree/blob 可读；只有对象 materialize 完成后才能让 checkpoint 引用它。

活动 store 禁用自动 GC。只要任一 session、checkpoint、cursor 或未完成 journal 引用 manifest，就保留对应对象；没有引用的 store 在至少 7 天后整库清理。孤立临时 index、ref 和 object 不影响已提交状态，清理失败进入后台重试而不是回滚用户文件。

### 5.3 Manifest

manifest 使用 canonical JSON 序列化并以 SHA-256 内容哈希作为 ID，至少包含：

- schema version、workspace identity、capture policy、topology fingerprint；
- root 列表：`relativeRoot`、`parentRoot`、`state`、`sourceIdentity`、`privateRepositoryId`、`treeId`、可选 `gitlinkOid`；
- 每个 root 的 coverage、ignore 规则版本和对象完整性校验值。

`absent` root 由 current/target 两个 manifest 的 root 并集派生，不在单个 manifest 中伪造。`active`、`uninitialized`、`broken/opaque` 状态必须区分；broken root 或无法读取的支持范围内文件会让 capture 失败，不静默降级。

## 6. 嵌套仓库与 submodule 文件语义

### 6.1 Root discovery

从 outer root 开始；如果 workspace 没有有效 Git root，则先建立一个仅存在于私有 store 中的 synthetic workspace root，`sourceIdentity` 使用 workspace canonical identity，`.gitignore` 使用 workspace root 的 Git ignore 语义：

1. 以只读方式读取当前 root 的 source index（必要时通过临时环境变量指定只读副本），执行 `git ls-files --stage -z`，把 mode `160000` 的 gitlink 作为 submodule 权威线索；`.gitmodules` 只作辅助。任何 staging 和 write-tree 都只能使用事务专属临时 index。
2. 在 scope 内进行受控 `.git` 扫描，使用 `lstat`，不跟随 symlink、junction 或 `.git` symlink；候选必须通过 `rev-parse --show-toplevel/--git-dir/--git-common-dir` 验证，canonical worktree 必须等于候选目录且位于 scope 内。
3. 发现有效 child root 后停止父 root 对该子树的普通文件扫描，再递归发现 child 的 nested root。
4. 以 canonical worktree 去重并按最近祖先建立 root forest。外部 gitdir、absorbed submodule 和 linked worktree 只读使用，不能扩大扫描范围。
5. gitlink 存在但没有有效工作树时记录 `uninitialized`；路径存在但不是有效仓库时记录 `broken/opaque` 并使 capture 失败。
6. capture 前后重新计算 topology fingerprint；变化则丢弃本次临时 index/tree，并有限重试。

### 6.2 Ignore 和边界

discovery 绕过父仓库 ignore，否则 embedded repository 可能永远不会被发现。每个有效 child 只使用自己的 ignore 规则，父 ignore 不向 child 传播。父私有 index 必须主动排除 descendant root 的 gitlink 和所有子路径；同一文件只属于最深有效 root。

普通 ignored 文件不进入快照，也不由 restore 删除或创建。symlink 保存链接本身，不跟随目标；空目录不作为快照对象。

### 6.3 Capture 与 restore

每个 root 用事务专属临时 index 完成 staging、write-tree 和对象 materialize。父 root 明确排除 child root，多个 root 的 tree 组合成一个 federated manifest。

恢复使用 `current roots ∪ target roots` 作为 boundary：

1. deepest-first 删除目标中不存在的普通内容，始终保留真实 `.git`。
2. shallowest-first 创建目标目录骨架，不创建 `.git`。
3. shallowest-first 写回父 root，再写回 child root；child 内容最终覆盖其边界内的父普通条目。
4. deepest-first 校验文件内容、mode、symlink、root topology 和 manifest coverage。

initialized submodule 可以恢复内部 dirty 和未跟踪文件，但不运行 `submodule update`，不切换实际 HEAD，也不修改 child index、refs 或 config。`.gitmodules` 是普通工作区文件，可以随其他文件恢复，但不足以重建 Git 元数据。

nested root 新增或删除时，manifest 的 root 并集决定需要清理或写回的普通工作区文件；真实 `.git` 已存在时始终保留，真实 `.git` 被删除时不由 package 重建。恢复后的目录可能因此成为普通目录或一个 dirty 的现有仓库，这是设计的明确 content-only 语义。

## 7. Checkpoint 与会话树模型

### 7.1 Checkpoint 结构

每个完整 Agent run 产生一个 checkpoint，至少包含：

- `runId`、原始用户 prompt、user entry ID、start entry ID、end logical leaf ID；
- `beforeManifestId`、`afterManifestId`、topology fingerprints；
- 展平后的 `changedPaths` 及每条路径所属最深 root；
- coverage、schema version、source identity 和 checkpoint checksum。

checkpoint custom entry、start custom entry、cursor custom entry 和 barrier custom entry 都使用 package namespace，例如 `pi-undo:start`、`pi-undo:checkpoint`、`pi-undo:cursor`、`pi-undo:barrier`。它们是普通 custom entry，不进入 LLM context。

undo head 和 redo stack 只沿当前活动 session branch 计算。BoundaryResolver 必须把 `pi-undo:*` custom entry 当作透明控制记录：cursor entry 的 parent 才是逻辑会话 leaf，start/checkpoint/barrier entry 不得进入 LLM context，也不能被当作用户消息边界。cursor entry 持久化当前 stack、active logical cursor、manifest ID、operation ID 和 descriptor checksum，旧分支上的 checkpoint 不会被删除。

### 7.2 正常 run 数据流

1. `input` 在 agent idle 且没有待处理 restore/recovery 时获取 workspace lock，并预先 capture before manifest，同时记录用户输入的原始文本。capture 失败返回 `handled`，保留编辑器文本，不启动本轮 Agent。
2. `before_agent_start` 使用已预备的 manifest，追加 start custom entry，绑定原始 prompt 和展开后的 prompt。新 prompt 若位于 undo 后的分支，在此时使普通 redo 失效；不能在 input 阶段提前清除，因为后续模型认证或 compaction 可能失败。
3. `agent_settled` 等所有自动继续行为结束后 capture after manifest，计算 changedPaths，并追加 checkpoint entry。
4. after capture 失败建立显式 history barrier，清除 redo，不能跨越不完整边界继续 undo。工作区修复后，下一次成功 before capture 从新 baseline 继续；旧历史不再被伪装成连续可撤销栈。

streaming 中的 steer/follow-up 不另建 before snapshot；它们属于同一个直到 `agent_settled` 的完整 run。

### 7.3 `/undo`

1. 获取 operation mutex。若已有操作，返回 busy，不 capture、不改变栈。
2. 如果 Agent 正在运行，调用 `ctx.abort()` 并用 package 自己的 idle deadline 包装 `ctx.waitForIdle()`。默认等待 30 秒；超时、reject 或仍有 RPC pending queue 时取消操作，绝不恢复文件。TUI abort 放回编辑器的排队文本不能被覆盖。
3. 检查 pending recovery/history barrier，并解析当前 undo head。没有可用项时只返回 `noop`，不写 journal。
4. capture 当前工作区作为本次 redo safety manifest；失败时 workspace、会话和栈完全不变。
5. 预检 target before manifest、changedPaths、root boundary、对象完整性、路径安全和 topology；原子写 `PREPARED` journal。
6. 用 `navigateTree(userEntryId, { summarize: false })` 把会话逻辑位置移到 user entry 的 parent；内部导航通过 operation ID 绕过重复的 tree 协调。
7. 只恢复该 checkpoint 的 changedPaths 到 before manifest，按 root forest 的恢复顺序执行并校验。
8. 恢复成功后追加带 operationId、from/to cursor、before manifest、redo safety manifest、stack frontier、coverage 和 descriptor checksum 的 cursor entry；回读完整 JSONL 行，确认 checksum/opId，并对 session 文件执行 fsync。未得到耐久确认不算提交。
9. 将 popped checkpoint 放入 redo stack，标记 journal committed，更新 footer，并尝试把原始 prompt 写回编辑器。编辑器是次要 UI，不会因为回填失败回滚已经提交的文件和会话状态。

restore 或 commit 失败时，command handler 可以导航回 source logical leaf，并用 safety manifest 做 set-state compensation；补偿必须重新校验。补偿失败进入 `recovery_required`，锁住新的 prompt、tool、tree 和 undo/redo。

### 7.4 `/redo`

redo 与 undo 使用同一个事务协议，方向相反：

- 从 redo stack 取出下一 checkpoint，并准备当前工作区的 undo safety manifest。
- 导航到该 checkpoint 的 end logical leaf。
- 对同一 changedPaths 恢复 undo 操作时保存的 redo source manifest，从而保留用户在 undo 前的手动修改。
- 文件和 topology 验证通过后，以一个 cursor entry 原子推进 redo/undo frontier。

redo 不默认重新读取原始 after manifest 覆盖无关路径；无关用户修改始终保持不变。changedPaths 上的外部冲突无法证明安全时 fail closed，不做 merge 或静默跳过。

### 7.5 新 prompt 与 `/tree`

undo 后的新 prompt 必须先成功完成 before capture。`before_agent_start` 追加新的 start entry 并清除普通 redo；旧分支及其 checkpoint 仍在 session tree 中，`/redo` 不再访问它们。

`/tree` 目标解析规则：

- user/custom message target 的 logical leaf 是其 parent，文件状态取该位置最近的完整 boundary，通常是对应 run 的 before state；
- non-user message target 的 logical leaf 是 target 本身，文件状态取该位置最近已完成的 after boundary；
- 运行中执行 `/tree` 时先 abort 并取消本次导航，idle 后由用户重试，避免最后一个 tool/message 接入新 leaf；
- 选择 run 内尚未封闭的中间 entry 时，不伪造逐工具文件状态，使用最近已完成 checkpoint；缺少完整 manifest、断裂 parent chain 或 topology 不可判定时取消导航。

`session_before_tree` 先做目标预检和 rescue capture；Pi 完成导航和可选 branch summary 后，`session_tree` 恢复目标文件并追加 cursor。若文件恢复失败，事件上下文没有反向 navigate API，package 保留 journal、尝试 rescue/重试，并进入 recovery lock，阻止新的 Agent run。普通 `/undo`、`/redo` 命令具有 command context，可以立即执行反向补偿；这是两条路径在失败语义上的唯一差异。

## 8. WAL、恢复与一致性

### 8.1 Journal 文件

每个操作生成唯一 `opId`，写入：

- immutable `descriptor.json`：session/workspace identity、操作类型、from/to logical cursor、manifest ID、coverage、plan digest、rollback manifest ID；
- immutable `restore-plan.json`：按路径和 root 排序的 set-state 操作；
- mutable `state.json`：阶段、单调 revision、descriptor hash、state checksum。

所有私有文件使用同目录临时文件，`fsync(temp)`、rename、`fsync(parentDir)`。内容寻址文件若已经存在，只验证字节一致，不覆盖。

阶段顺序为：

```text
PREPARING -> PREPARED -> SESSION_MOVED -> APPLYING
           -> FILES_VERIFIED -> CURSOR_COMMITTED -> COMMITTED
```

`ABORTING`、`ABORTED` 和 `RECOVERY_REQUIRED` 用于补偿和锁定状态。只有 target files 已验证、cursor JSONL 中存在完整 checksum-valid commit marker 并完成 fsync 后才可报告 `ok`。

### 8.2 失败矩阵

- idle、preflight、safety capture 或 journal PREPARED 写入失败：没有文件和 cursor 变化，临时对象可延迟清理。
- 文件 apply/verify 失败：使用 pinned rollback manifest 做 set-state restore；验证成功后历史和栈不变。
- rollback 失败、coverage 不完整、对象损坏、topology 不稳定、路径逃逸或外部并发冲突：保留所有 journal/pin，进入 `RECOVERY_REQUIRED`，停止新的 mutation。
- cursor append 返回 ambiguous：扫描 session JSONL 的完整 operationId、checksum 和 newline；找到相同 payload 则向前补完，找不到则回滚。相同 opId 不同 payload 视为 corruption。
- cursor commit 已耐久但 UI、日志或 GC 清理失败：只向前补完目标状态，不反向撤销已提交 cursor；状态为 `COMMITTED_CLEANUP_PENDING`。

Pi 的 `appendEntry()` 可能先移动内存 leaf 再写文件，因此 package 不能把函数返回当作提交确认。操作 lock 下必须读取 session file、确认完整 JSONL line、fsync 并校验 opId。若同一进程内无法修复内存/磁盘分叉，进入 recovery lock，不允许继续追加父级依赖该 ghost entry 的新消息。

### 8.3 启动恢复

`session_start` 开始恢复流程，并由 `input` gate 在恢复完成前阻止新 prompt。恢复必须取得 workspace lock，按 journal 和当前 session tree 重复执行且幂等：

- journal 有但没有有效 cursor commit marker：操作未提交，恢复 rollback manifest 并校验，标记 `ABORTED`；
- 有有效 cursor commit marker：操作已提交，重复恢复 target manifest 并校验，重建 cursor/stack，标记 `COMMITTED`；
- journal、manifest、JSONL payload 或 opId 不一致：不猜测，进入 `RECOVERY_REQUIRED`；
- clean journal 且 manifest 完整：静默恢复 footer，不重复发送 chat notify；中断恢复只发送一次 warning/info。

恢复完成前不启动新的 Agent run、不接受新的 tree/undo/redo mutation。连续重启不能重复推进 stack。

## 9. 用户可见状态与结果码

footer 使用单一 key `pi-undo`，只显示短单行状态：

```text
undo:3 redo:1
undo: stopping agent
undo: saving current state
undo: restoring 2/5
undo: snapshot failed
undo: recovery required
```

详细原因通过 `notify()` 发送，所有业务结果同时使用稳定 machine code，至少包括：

`ok`、`noop`、`busy`、`idle_timeout`、`capture_failed`、`restore_failed_safe`、`partial_restore`、`recovery_required`、`history_paused`、`refill_skipped`、`refill_failed`。

推荐文案：

- 成功：`Undid "<label>" (N files). Redo is available.`、`Redid "<label>" (N files).`
- 无可用项：`Nothing to undo.`、`Nothing to redo.`
- 安全失败：`Undo cancelled: ... No files changed.`
- 补偿成功：`The workspace was restored to its pre-undo state; history was not changed.`
- 不确定：`The workspace may be inconsistent. Undo and redo are locked until recovery.`

stderr、绝对快照路径、Git token 或终端控制字符不能直接写入 footer/notify；reason 需要单行化并限制长度。

TUI 中只有 editor 为空时才写回 prompt，并 read-back 验证；editor 非空时不覆盖并返回 `refill_skipped`。RPC 的 `setEditorText()` 是 fire-and-forget，不能报告 `refill=applied`，只能报告 requested/unsupported；print/json 直接报告 unsupported。reload 和 session replacement 后重新设置 footer，不能依赖旧 UI 状态。

## 10. 测试与验收设计

测试使用 Pi 现有 Vitest、faux provider、AgentSessionRuntime 和临时目录模式，所有 Git 集成测试使用本地临时仓库，不访问网络。

### 10.1 纯逻辑单元测试

- root discovery、canonical path 去重、symlink 不跟随、gitlink/submodule 状态和 topology fingerprint。
- parent/child ignore 隔离、最深 root ownership、manifest forest、changedPaths 和 target boundary。
- 普通文件、二进制、大文件、未跟踪、删除、rename、executable bit、symlink；ignored 文件、`.git` 和空目录的排除语义。
- manifest schema、checksum、coverage、对象缺失、路径越界、topology 改变和 restore plan 幂等性。

### 10.2 Git 集成测试

- 非 Git 项目的私有 GIT_DIR 创建，验证项目目录没有 `.git`。
- 已有 Git 项目恢复后真实 HEAD、index、refs、reflog 保持原值。
- 隔离真实 object database 后私有 tree 仍可读取，证明没有 alternates 依赖。
- 多层 nested repository、initialized submodule 的内部 dirty/untracked 恢复。
- uninitialized/broken submodule 显式失败，不静默漏掉文件。
- 大于 2 MiB 文件、ignored 文件、symlink 和 root 新增/删除。

### 10.3 Pi 会话集成测试

- 一个完整 Agent run 只产生一个 checkpoint；`agent_settled` 后才可 undo。
- `/undo`、`/redo` 的文件状态、session tree、prompt refill、stack frontier 和 restart 状态。
- 连续 undo/redo、root/user/assistant/custom target、旧分支 `/tree`、新 prompt 清 redo。
- streaming abort、tool 未停止、queued message、retry、compaction 和 follow-up。
- `/tree` streaming cancel、summary cancel、branch summary、current leaf drift、session reload/resume/new/fork。
- RPC、print/json、TUI 三种 UI 模式的 footer、notify 和 refill 语义。

### 10.4 故障注入与 crash recovery

在 PREPARED、SESSION_MOVED、restore 中途、FILES_VERIFIED、cursor append 前后、journal COMMITTED 前后注入进程退出或异常，验证：

- capture、Git 命令、object materialize、topology retry、lock 冲突和 idle timeout；
- restore 第 `k` 个路径失败，rollback 成功或进入 recovery；
- cursor append ambiguous、完整行已落盘、torn JSONL、重复 opId、不同 payload 冲突；
- journal 连续恢复两次不会重复移动 cursor；
- UI/editor/log/GC 失败不会伪造文件事务失败。

所有命令必须在 `finally` 后清理 busy footer；成功提示之前必须观察到 target fingerprint verified 和 cursor commit marker durable。任何 partial restore 都不能显示 `Undid` 或 `Redid`。

### 10.5 验收标准

实现只有在以下条件全部满足后才算完成：

1. 正常路径、嵌套 root、submodule、非 Git 项目、大文件和重启测试通过。
2. restore 或 rollback 无法验证时 workspace 进入 recovery lock，新的 Agent mutation 被阻止。
3. 用户真实 Git 元数据未被创建、提交、切换、删除或重写。
4. undo/redo 数量和历史只在一次 durable cursor commit 后改变一次。
5. 所有可见结果包含稳定 reason code，且不会把 RPC/UI no-op 报告为成功。
6. 不修改 Pi 核心源码，不要求用户手动执行 Git 命令。

## 11. 实施前检查清单

- 先实现并测试 SnapshotStore、RootDiscovery 和 RestoreEngine，再接入 Pi event adapter。
- 为所有可变操作接入同一个 workspace lock 和 operation journal。
- 在实际 Pi 0.80.10 上验证 session JSONL append、fsync、reload 和 stale ctx 行为；不能仅凭类型定义假设原子性。
- 在 package 代码和测试完成前，不把当前设计文档中的恢复承诺扩大到真实 Git 元数据、外部并发进程或 ACID 事务。
