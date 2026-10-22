# Pi 1.4.0 兼容验证记录

验证对象：`@davideasden/pi-undo` 当前工作树。

验证环境：Pi 1.4.0（`@earendil-works/pi-coding-agent@1.4.0`，npm 发布产物）、Node.js 23.11.1、macOS arm64。生命周期接口以 Pi 1.4.0 的 `core/extensions/types.ts` 与 SDK 行为为准；测试使用离线 faux provider，不请求模型网络。

## 结论

pi-undo 无需改动源码即可在 Pi 1.4.0 上运行。1.3.0 → 1.4.0 的扩展 API 没有任何改动：`core/extensions/types.ts`、`core/extensions/runner.ts`、`core/session-manager.ts` 均未变更，差异只在加载器新增 `@earendil-works/pi-ai/models` 别名。

开发依赖与测试夹具已从 1.3.0 提升到 1.4.0；`peerDependencies` 仍为 `>=1.2.0`，运行时不绑定具体版本。

## 验证项目

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（`src`／`extensions`／`test`，对着 1.4.0 类型） | 通过 |
| `npm test` | 25 个测试文件通过、5 个跳过；680 项通过、10 项跳过 |
| 真实加载器加载包目录（`DefaultResourceLoader` + `additionalExtensionPaths`） | 0 错误，注册 `undo`／`redo`／`diff`／`undo-cancel`／`undo-recover` 与全部 8 个事件处理器 |
| 端到端（真实加载器 + faux provider） | run → `/undo` → `/redo`，文件内容与 footer 状态正确 |

加载器检查使用 1.4.0 的 `DefaultResourceLoader` 加载包根目录（`package.json` 的 `pi.extensions` 指向 `extensions/pi-undo.ts`），验证 TypeScript 转译、`../src/*.ts` 相对导入与 `proper-lockfile` 解析；断言 `errors` 为空且命令与事件齐全。

跳过项与 1.3.0 一致：`durable-pack-*`／`tree-query` 基准、`large-workspace` 基准，以及需要 `PI_UNDO_RUN_RESIDENT_LIVE=1` 的常驻扫描 smoke。

## 1.3.0 → 1.4.0 变更核对

- 扩展类型与事件形状未变：`ExtensionContext`、`ExtensionCommandContext`、`input`、`message_end`、`before_agent_start`、`agent_settled`、`session_before_tree`、`session_tree` 与 1.3.0 完全一致。
- 交互式扩展对话框改为栈式实现（`select`／`confirm`／`input`／`editor`／内联 `custom` 可嵌套，关闭后回到上一个，不再出现 promise 永久挂起）。`/diff` 使用 `ui.select` + `ui.custom({ overlay: true })`，走 overlay 路径，行为不变；嵌套场景下比 1.3.0 更可靠。
- `AgentSession` 的改动集中在溢出恢复的 tool result 配对与 `_restoreToolsFromTranscript`，不涉及 pi-undo 依赖的 run 生命周期、`agent_settled` 派发与树导航。
- 加载器新增 `@earendil-works/pi-ai/models` 别名；pi-undo 运行时不导入 `pi-ai`，无影响。

## 关键边界处理

1.3.0 的边界结论在 1.4.0 上没有回归：

- `before_agent_start` 的 `messageType: "custom"` 仍然不创建 undo run。
- workspace canonical root 变化时，捕获失败原因包含 `workspace_identity_changed`，用户输入继续执行但不进入撤回历史，并提示 `/undo-recover`。
- 后台 finalization 失败会立即锁定撤回历史，等 `/undo-recover` 重试。
- `mutation_conflict` 继续 fail closed，不会自动猜测回滚或前进方向。

## 剩余限制

未在 Windows 和 Linux 上重复完整测试。TUI 对话框栈只在类型与调用路径上验证，未做人工交互回归。1.3.0 的历史记录见 [pi-1.3.0-validation.md](pi-1.3.0-validation.md)。
