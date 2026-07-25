# pi-undo

`pi-undo` 为 Pi 0.80.10 提供持久化的 `/undo` 和 `/redo`。一次操作对应一个完整 Agent run，并同时恢复 Pi session tree 的逻辑位置和工作区文件。

实现使用 Pi session JSONL、私有 snapshot store 和 WAL journal。它不会在项目中创建 `.git`，也不会要求用户执行 `git commit`、`git stash`、`git reset` 或维护隐藏分支。

## 安装与本地试用

安装本地 package：

```bash
pi install ./path/to/pi-undo
```

开发时也可以直接加载 extension：

```bash
pi -e /absolute/path/to/pi-undo/extensions/pi-undo.ts
```

要求 Node.js 22.19 或更高版本，并且系统可执行 `git`。

## 使用方式

- `/undo`：回退当前 branch 上最后一个完整 Agent run。执行前会保存当前工作区作为 redo safety snapshot。
- `/redo`：恢复最近一次 undo 前保存的工作区状态，而不是简单覆盖成 checkpoint 的原始 after snapshot。
- `/tree`：仍使用 Pi 原生命令。package 在导航前预检目标 boundary 并保存 rescue snapshot，导航完成后恢复该 boundary 对应的文件状态。

如果 Agent 正在 streaming，`/undo` 和 `/redo` 会先请求 abort，再等待 Agent idle；等待超时或工具仍未停止时不会恢复文件。streaming 中的普通 `/tree` 会被取消，用户可在 idle 后重试。

undo 成功后，TUI 编辑器为空时会尝试回填原始 prompt；编辑器已有文字时不会覆盖用户输入。RPC 只报告回填请求，print/json 模式不承诺编辑器回填。

## 数据与 Git 边界

私有数据位于 Pi session 目录下：

```text
<sessionDir>/.pi-undo/
```

snapshot 使用独立 Git object database 和临时 index，但不会写入用户仓库的 `HEAD`、index、refs、reflog、stash、config 或其他真实 Git metadata。

普通目录、outer repository、nested repository 和已初始化 submodule 都按 root forest 独立捕获和恢复。nested repository/submodule 只恢复内部工作区文件：

- 不切换真实 HEAD；
- 不运行 `git submodule update`；
- 不修改真实 index、refs、reflog 或 `.git`；
- 不重建被删除的真实 `.git`。

## 持久化与故障恢复

每次 undo、redo 或 tree restore 都先写 WAL journal。Pi 重启后：

- 没有可信 cursor marker：恢复 rollback manifest，并把操作终止为 `ABORTED`；
- 有可信 cursor marker：重新恢复 target manifest、补齐 cursor durability，并把操作完成为 `COMMITTED`；
- journal、session identity、logical leaf、manifest 或 cursor payload 不一致：进入 `recovery required`，停止新的 undo/redo、tree mutation 和 Agent boundary。

故障 journal 会保留在 `<sessionDir>/.pi-undo/transactions/`，用于诊断和人工恢复。不要在未备份的情况下删除该目录。footer 显示 `recovery required` 时，应先保存工作区和 session JSONL，再检查对应 transaction 的 `descriptor.json`、`restore-plan.json` 和 `state.json`。

## 明确限制

- Git ignored 文件不进入 snapshot，也不会被 restore 创建或删除。
- 空目录不属于 snapshot。
- package 不恢复真实 `.git` metadata。
- package 锁只能协调其他 `pi-undo` 实例，不能阻止外部编辑器、watcher 或其他进程同时写文件；无法证明安全时会 fail closed。
- `--no-session` 模式没有可耐久验证的 session cursor，只提供进程内能力，不能承诺进程崩溃后的 undo/redo 持久化。
- uninitialized gitlink 不会被自动初始化；broken nested root 会使 capture 失败，而不是静默遗漏。
- package 不对工作区文件与 Pi JSONL 提供操作系统级 ACID 事务；它通过 snapshot、WAL、cursor marker 和幂等 set-state recovery 收敛到旧状态或新状态。

## 开发验证

```bash
npm test
npm run test:integration
npm run typecheck
npm run pack:dry-run
```

真实 Pi `AgentSession` 集成测试需要先安装并构建 `resources/pi-0.80.10` 的 workspace packages。
