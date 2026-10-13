# Pi 1.2.0 兼容验证记录

验证环境：macOS arm64、Node.js 23.11.1、Pi SDK 1.2.0（`~/.pi/agent/install/releases/1.2.0`）。所有 SDK 场景使用离线 faux provider，不请求模型网络。

## 结论

pi-undo 0.2.32 在 Pi 1.2.0 上无需改动源码即可运行。最低支持版本由 0.86.1 提升到 1.2.0，开发依赖与测试夹具固定为 1.2.0。

## 验证内容

| 检查 | 0.86.1 | 1.2.0 |
| --- | --- | --- |
| `npm run typecheck`（`src`／`extensions`／`test`） | 通过 | 通过 |
| `npm test` | 24 文件通过／1 跳过，635 项通过、4 项跳过 | 完全一致 |
| 真实加载器加载 `extensions/pi-undo.ts` | — | 0 错误，注册 `undo`／`redo`／`diff`／`undo-cancel`／`undo-recover` 与全部 8 个事件处理器 |

加载器检查使用 1.2.0 的 `discoverAndLoadExtensions()`（与 Pi 启动时相同的 jiti 路径），在隔离目录中加载扩展文件，断言 `errors` 为空且命令与事件齐全。跳过项是需显式开启的大型工作区基准（`PI_UNDO_LARGE_WORKSPACE=1`）。

## 1.1.0 → 1.2.0 破坏性变更核对

- `before_agent_start` 现在是联合类型，且对 `pi.sendMessage(..., { triggerTurn: true })` 触发的自定义消息 run 也会触发。pi-undo 的处理器不读取事件对象；自定义 run 没有 staged 输入，`beforeAgentStart()` 与 `agentSettled()` 都会提前返回，因此只多一次空调用。
- 会话在 run 启动期间（含 `before_agent_start` 处理器内）记为 busy，`pi.sendUserMessage()` 此时需要 `deliverAs`。pi-undo 只在撤回／重做完成且空闲后重放排队输入；即使出现竞态，运行时也会把错误作为扩展错误上报，不会中断 Pi。
- `agent_settled` 新增 `aborted` 字段，纯增量，pi-undo 不使用。

## 版本解析

Pi 的 jiti 加载器通过虚拟模块把 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 等映射到运行实例，因此扩展不会与本地 `node_modules` 中的旧版本混用。

## 边界

未在 Windows／Linux 上重复整套验证；未覆盖与其他扩展同时触发 `before_agent_start` 的交互式 TUI 场景。0.86.1 的历史记录见 [pi-0.86.1-validation.md](pi-0.86.1-validation.md)。
