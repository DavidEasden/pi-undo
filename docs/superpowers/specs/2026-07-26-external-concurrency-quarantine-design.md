# 外部并发修改原子隔离设计

## 目标

在 undo、redo、tree restore 的每个叶子 mutation 前，将现场对象以同文件系统原子操作保留下来，并再次验证其状态。外部进程在 restore 期间修改文件时，pi-undo 必须优先保留外部内容并停止恢复，不能静默覆盖。

该能力不修改真实 Git metadata，也不声称阻止任意外部进程写入。它通过原子隔离、no-clobber 安装、WAL 和故障恢复缩小并发竞态，并在无法证明安全时 fail closed。

## 非目标

- 不实现容器、虚拟机或 overlay filesystem 隔离。
- 不依赖编辑器或外部进程主动遵守 pi-undo workspace lock。
- 不对目录树执行整体 rename，避免移动 nested repository、submodule、ignored 文件或真实 `.git`。
- 不提供默认强制覆盖外部修改的选项。

## 当前基础与缺口

`RestoreEngine.mutate()` 已在每次 `delete`、`write`、`mkdir`、`symlink` 前调用 `assertMutationPath()` 和 `assertMutationState()`。它能够发现发生在检查之前的外部修改。

现有缺口是检查与 mutation 之间仍有 TOCTOU 窗口：外部进程可能在状态验证后、`unlink`、`rename` 或原子写入前改变路径。新协议必须保存 mutation 瞬间观察到的现场对象，并避免目标安装覆盖重新出现的路径。

## 总体架构

新增三个边界清晰的组件：

1. `MutationJournal`：在现有 transaction 目录中维护 append-only `mutations.jsonl`，负责记录每个路径 mutation 的意图和已完成步骤，并对每条记录执行 checksum、LF、文件 fsync 和目录 fsync。
2. `QuarantineManager`：只负责创建同目录隔离路径、移动或保留现场叶子、安装目标叶子、恢复隔离叶子和清理 artifact。
3. `QuarantineRecovery`：在普通 manifest capture 之前读取可信 mutation log，根据原路径、隔离路径和目标路径的可证明状态，将未完成 mutation 收敛到 rollback 或 target 状态。

`RestoreEngine` 继续负责 plan、路径安全、manifest 证明、mutation 顺序和最终验证。它不自行推断不可信 artifact 的归属。

## Artifact 命名与所有权

每个 artifact 位于被修改路径的父目录，从而保证与目标位于同一文件系统。名称不包含原始文件名，只包含固定前缀和不可预测 nonce：

```text
.pi-undo-q1-<nonce>-source
.pi-undo-q1-<nonce>-target
```

nonce 由 128 位安全随机数生成。完整路径在 mutation intent 中持久化，恢复器不通过扫描文件名前缀认领 artifact。

只有同时满足以下条件的 artifact 才能被 pi-undo 忽略、移动或删除：

- 对应 transaction descriptor、state 和 mutation log 均通过 checksum 与身份校验；
- artifact 路径是 workspace 内安全相对路径，且不包含 `.git` 组件；
- mutation record 的 workspace identity 与当前 workspace 一致；
- artifact 的类型、inode 状态或内容 fingerprint 与该 mutation 当前阶段允许的状态一致。

名字相似但没有可信 journal 证明的文件一律视为用户文件。

## Mutation WAL

每个 mutation 使用固定 ordinal，并依次写入以下状态：

```text
INTENT
SOURCE_QUARANTINED
SOURCE_VERIFIED
TARGET_INSTALLED
TARGET_VERIFIED
CLEANED
```

每条记录包含：

- schema version、opId、ordinal；
- mutation kind 和原始 workspace path；
- source artifact、target artifact 路径；
- 预期 source state 与 target state 的 fingerprint；
- 当前 mutation state；
- 上一条 mutation record checksum；
- 本条 record checksum。

`INTENT` 必须在创建 target temp 或移动 source 之前落盘并 fsync。后续每个会改变目录项的操作完成后，先 fsync 相应父目录，再写下一状态。mutation log 是 hash chain，重复 ordinal、状态回退、跳跃或字段冲突都会进入 recovery lock。

## 普通文件写入流程

1. 计算 source artifact、target artifact 和预期 fingerprint，写入并持久化 `INTENT`。
2. 从 target manifest 读取 blob，在目标父目录创建 `target artifact`，使用 `wx`，写入完整 bytes、设置 mode、fsync 文件和父目录。
3. 再次执行现有路径安全和 known-state 校验。
4. 如果原路径存在，将原路径移动到 `source artifact`，fsync 父目录，记录 `SOURCE_QUARANTINED`。
5. 对 source artifact 重新计算完整 fingerprint。它必须等于 current manifest 或允许的幂等 target state；否则尝试 no-clobber 恢复原路径，停止 transaction。
6. 记录 `SOURCE_VERIFIED`。
7. 使用 no-clobber 方式安装 target。普通文件优先使用同目录 hard-link target artifact 到原路径，再 unlink target artifact；原路径已重新出现时必须得到 `EEXIST` 并停止，不能使用会覆盖目标的普通 rename。
8. fsync 父目录，记录 `TARGET_INSTALLED`。
9. 验证原路径完整 fingerprint，记录 `TARGET_VERIFIED`。
10. 在 transaction 已不再需要 source artifact 进行补偿时清理它，并记录 `CLEANED`。

不支持 hard-link 的文件系统必须 fail safe；第一版不以 copy 或覆盖式 rename 降级，因为这会重新引入覆盖竞态。

## Symlink 流程

symlink 不读取目标内容，只验证 link text 和类型。

- 现场 symlink 通过同目录原子 rename 移入 source artifact；
- 隔离后重新验证 link text；
- 目标 symlink 直接以 `symlink()` 创建到原路径，该调用具备 no-clobber 的 `EEXIST` 语义；
- 原路径被外部重建时停止，不覆盖；
- rollback 仅在原路径不存在时恢复 source artifact。

## 删除流程

删除普通文件或 symlink 时不立即 unlink：

1. 持久化 `INTENT`；
2. 原子移动到 source artifact；
3. 重新验证 source artifact fingerprint；
4. 将目标状态记为 absent 并执行 absent verification；
5. transaction 可以安全提交后才清理 source artifact。

如果验证发现外部内容，恢复 source artifact 并中止。目录删除仍沿用“验证为空后 `rmdir`”逻辑，不整体隔离。

## 目录操作

目录不进入 quarantine：

- 创建使用 `mkdir`，遇到 `EEXIST` 后重新验证类型；
- 删除只允许 `rmdir` 空目录；`ENOTEMPTY` 表示外部或 ignored 内容存在，目录保持不变；
- nested root boundary、submodule 和任何包含 `.git` 的路径继续由现有安全检查拒绝移动。

## Snapshot 与 artifact 隔离

active transaction 的可信 mutation log 提供精确 artifact path 集合。SnapshotStore 只能在调用方显式传入该集合时排除这些 exact paths，不能按名称前缀全局忽略。

规则如下：

- 普通 capture 不排除任何 artifact 名称；
- restore 内部验证 capture 只排除当前可信 transaction 已登记的 exact paths；
- startup recovery 必须先处理 pending quarantine，再允许普通 input capture；
- 如果 artifact 存在但没有可信 mutation record，进入 recovery lock，不能把它静默排除或删除；
- transaction 收敛后必须证明所有登记 artifact 已清理，才允许标记 `COMMITTED` 或 `ABORTED`。

## 崩溃恢复决策

恢复器逐个 mutation 按 ordinal 处理：

| 现场状态 | 决策 |
| --- | --- |
| 只有原路径，且等于 source | 视为 mutation 尚未开始，rollback |
| 只有 source artifact，且等于 source | 恢复原路径，rollback |
| source artifact 等于 source，原路径等于 target | 可 roll forward 或 rollback，由 durable cursor 决定 |
| 原路径等于 target，source artifact 缺失 | 仅当 mutation log 已到 `TARGET_VERIFIED` 才允许 roll forward |
| 原路径出现未知内容 | 保留原路径和 artifact，进入 recovery lock |
| source artifact 出现未知内容 | 保留所有内容，进入 recovery lock |
| target artifact 出现未知内容 | 保留所有内容，进入 recovery lock |

durable cursor 仍是整个 undo/redo/tree transaction 的提交判据：有可信 cursor 时向 target 收敛；没有 cursor 时向 rollback manifest 收敛。mutation log 只证明每个文件 mutation 的中间状态，不能替代 cursor。

## 外部并发冲突语义

检测到外部并发时，返回结果必须区分：

- `restore_failed_safe`：外部内容已恢复到原路径，workspace 可证明未被 pi-undo 覆盖；
- `recovery_required`：原路径和 artifact 无法无损自动合并，所有内容均保留，等待重启恢复或人工处理。

如果 workspace alias、canonical root 或 artifact 上层目录在 mutation 后换向，恢复器不能再通过原相对路径证明 artifact 归属并无损恢复。此时必须保留 WAL、artifact 和外部内容并返回 `recovery_required`，不得为了返回 `restore_failed_safe` 而跨越已变化的身份边界清理现场。

状态报告应包含冲突路径数量和 transaction opId，但不在 TUI 中输出文件内容。

## 测试策略

### 单文件竞态

- 写前外部修改，确认外部内容保留且 target 未安装；
- source quarantine 后外部重建原路径，确认 no-clobber 安装失败且两个版本均保留；
- target 安装后外部再次修改，最终验证失败并保留 WAL；
- delete 前、delete 隔离后分别注入外部修改；
- 普通文件、可执行文件、二进制、大文件和 symlink 分别覆盖。

### 故障注入

在每个 mutation state 写入前后注入进程异常，重新构造 runtime 并验证：

- 无 cursor 时恢复 rollback；
- 有 cursor 时恢复 target；
- 重复 recovery 幂等；
- mutation log 截断、重复、checksum 冲突时 fail closed；
- artifact 清理失败可在下一次启动继续。

### 工作区结构

- 普通目录；
- outer repository；
- 两层 nested repository；
- initialized submodule；
- uninitialized submodule；
- ignored 文件与 scope 外用户修改；
- 所有场景验证真实 Git HEAD、index、refs、reflog、stash 和 config 前后不变。

### 并发压力

- 两个 pi-undo 进程仍由 workspace lock 串行；
- 外部 writer 在随机 mutation ordinal 修改随机文件；
- 至少执行数百轮，断言结果只能是完整 target、完整 rollback，或保留全部冲突版本的 recovery lock，不能静默丢失外部 bytes。

## 实施边界

第一版只对普通文件和 symlink 启用 quarantine。目录保持现有安全语义。所有新格式均带 schema version，不兼容或损坏的 mutation log fail closed。现有无 mutation log 的旧 journal 继续由原 recovery 协议处理，确保升级后可恢复已有 transaction。

在 Controller 于 Task 6 强制传入 operation identity 前，旧两参数 `apply` 只是迁移兼容路径。它每次调用都使用 `mkdtemp` 创建独立、不可预测的临时 journal，不在并发调用间共享 WAL。journal 已 clean 时只删除本次创建的精确临时目录；存在 active mutation 时保留现场。该临时 WAL 不具备 startup recovery 承诺，Task 6 必须删除此兼容路径并改用 transaction 目录中的 journal。

## 验收标准

- 每个普通文件和 symlink mutation 都有 durable intent 和逐阶段证据；
- 目标安装不使用覆盖式 rename；
- 外部重建原路径时不会被覆盖；
- 任一阶段崩溃后可依据 cursor 和 mutation log 幂等收敛；
- 未被可信 journal 认领的文件永远不会作为 artifact 删除；
- nested repository/submodule 和真实 Git metadata 行为保持现有约束；
- 全量测试、故障注入、并发压力测试与 package dry-run 通过。
