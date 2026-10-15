# Pi 1.3.0 兼容验证记录

验证对象：`@davideasden/pi-undo` 当前工作树。

验证环境：Pi 1.3.0、Node.js 23.11.1、macOS arm64。生命周期接口以 Pi 1.3.0 的导出类型和 SDK 行为为准；测试使用离线 faux provider，不请求模型网络。

## 结论

pi-undo 使用的扩展生命周期、命令、会话树和编辑器 API 在 Pi 1.3.0 上保持兼容。1.3.0 新增的 `before_agent_start` custom run 不会被 pi-undo 误记为用户 Agent run。

后台 durable pack finalization 失败时，当前 runtime 会立即进入 `recovery_required`，并保留事务供 `/undo-recover` 重试。外部文件与 mutation journal 指纹冲突时仍然 fail closed，不会自动猜测回滚或前进方向。

## 验证项目

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 24 个测试文件通过，2 个跳过；642 项通过，5 项跳过 |
| Pi 1.3.0 扩展类型兼容性 | 通过 |
| `before_agent_start` 的 `messageType: "custom"` | 不创建 undo run |
| `before_agent_start` 的 `messageType: "user"` | 保持原有用户 run 生命周期 |
| finalization failure 的 controller lock | 通过单元测试 |
| mutation conflict recovery | 保持 fail closed，并显示 `opId` 与处理提示 |

## 关键边界处理

- `pi.sendMessage(..., { triggerTurn: true })` 触发的 custom run 没有用户 `input` 边界，pi-undo 跳过 `beforeAgentStart()`。
- workspace canonical root 变化时，捕获失败原因包含 `workspace_identity_changed`，用户输入继续执行但不会进入撤回历史；提示用户运行 `/undo-recover` 重新发现工作区。
- 后台 finalization 失败会锁定当前撤回历史，不再静默等待下次启动。
- `mutation_conflict` 继续保留事务和隔离文件，要求用户先备份并停止其他写入程序，再根据 `opId` 检查现场。

## 剩余限制

未在 Windows 和 Linux 上重复完整测试。`mutation_conflict` 的自动解除仍然被禁止，这是为了避免在外部写入与 pi-undo 操作无法确定先后时造成不可逆覆盖。
