# 原生目录扫描与普通文件恢复性能验证

这批优化在保留五个拓扑检查点和恢复 fail-closed 语义的前提下，增加逐目录拓扑快照复用，并把 scoped restore 的可见路径枚举限制在实际 scope 内。

## 实现与边界

- `scan-directories-v2` 在 macOS/Linux 上通过私有 cache 保存每个目录的 `dev/ino/mtime/ctime`、Git 标记、直接子目录和 racy 标记。下一次检查仍逐个打开缓存中的目录并复核身份与时间戳；只有可证明未变化、缓存记录不处于 racy 窗口且时间戳精度足够的目录才跳过 `readdir`。目录替换、子目录增删、扫描期间时间戳变化、粗粒度时间戳或 cache 损坏都会回退到完整子树扫描；深度、symlink、`.git` 和 workspace identity 约束保持不变。
- 新 helper 只做一次能力探测，优先使用 v2；旧的 `scan-directories-v1` helper 仍走完整扫描，缺少 helper 时继续使用 TypeScript 回退。v2 cache 位于 workspace 外的私有临时目录，并在进程退出时清理；临时目录无法安全放置或 cache 无法写入时不影响正常扫描。
- `listVisibleLeafPaths` 支持 `includePaths`。完整 restore 仍枚举整个工作区；带 scope 的 complete restore 只枚举 scope 内的 visible leaves，scope 外新建文件按 scoped restore 语义保留。scope 内新增路径、类型冲突和 topology 漂移仍 fail-closed。
- `restore-files-v2` 支持普通文件覆盖、创建、删除的混合计划，以及子目录中的文件删除。父目录必须已经存在。读取、校验、no-clobber 安装及隔离均绑定同一组父目录句柄；最多保留 128 个非根父目录句柄。目录创建/删除、类型替换、过多父目录与不支持的平台继续使用 TypeScript。
- durable pack 格式与恢复协议保持不变。仍在修改前发布并持久化 pack，逐项校验内容和 mode，保留同 inode 的 ownership artifacts。失败时由现有 packed recovery 回滚；外来冲突文件不会被当成本次产物删除。

## 实测结果

环境为本机 macOS arm64、Node 23.11.1、真实 Pi 0.86.1 SDK 与离线 faux provider。每个场景执行三次 undo，中间执行 redo 并等待后台恢复/持久化清理结束；校验文件内容、撤回/重做历史状态和扫描次数。表内为中位数，单位毫秒。基线与优化版本在同一机器先后执行，未施加墙钟性能断言。

| 场景 | 优化前 | 优化后 | 耗时降低 |
| --- | ---: | ---: | ---: |
| 无依赖目录，修改 1 文件 | 146 | 148 | 约持平 |
| 3,000 包，修改 1 文件 | 1,976 | 924 | 53% |
| 10,000 包，修改 1 文件 | 5,857 | 2,755 | 53% |
| 10,000 包，修改 1 文件（v2 目录 cache） | 5,857 | 2,423 | 59% |
| 100 文件全部覆盖 | 179 | 182 | 约持平 |
| 100 文件在根目录新增后撤销 | 177 | 174 | 约持平 |
| 100 文件在已有子目录新增后撤销 | 517 | 180 | 65% |
| 50 文件覆盖、50 文件新增后混合撤销 | 711 | 186 | 74% |

分阶段计时中，3,000 包场景五次扫描合计从 1,759 ms 降至 716 ms；10,000 包从 5,470 ms 降至 2,398 ms。全部测量仍为五次扫描。新增目录的撤销测试保留父目录中的 `keep.txt`，因此测量的是文件删除，不含目录删除。混合与子目录场景原先未进入 native，优化后三次均调用原生恢复一次。

另一个既有大型工作区基准覆盖 3,000／10,000 包 × 1／100 文件，四组均通过内容、redo 和 `[5, 5, 5]` 扫描次数断言。该次单独运行的中位数依次为 878、923、2,582、2,673 ms；与分阶段诊断是不同批次，不把两批耗时混作同一组数据。

这些是三次采样的本机结果，主要证明已观察到的热路径得到改善。磁盘、目录结构、并发写入和机器负载会影响绝对耗时；没有从这些结果推断其他操作系统上的收益。

## 复现与验证

最终验证通过：Rust 单测 11 项、原生相关 TypeScript 测试 74 项、默认完整 Vitest 621 项（4 项按需基准跳过）、强制 TypeScript 回退 589 项（36 项不适用原生测试或按需基准跳过）；TypeScript 类型检查、10,000 包大型工作区基准及 npm 打包内容检查通过。

```bash
npm run build:native
cp native/pi-undo-fs/target/release/pi-undo-fs native/bin/pi-undo-fs-darwin-arm64
npm run test:native
npm test
PI_UNDO_DISABLE_NATIVE=1 npm test
npm run typecheck
PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts
```

上面的二进制复制路径用于本次 macOS arm64 环境；其他平台须使用对应构建产物。此批已更新仓库现有的 macOS arm64 二进制。Linux、其他架构和 Windows 的源码构建/运行不在本机验证范围内；缺少二进制或扩展能力时会回退，发布时仍需现有六平台构建流程提供对应产物。

本轮完整验证还覆盖了原生/TypeScript 拓扑一致性、ignored 嵌套仓库、大小写不同的 Git 标记、符号链接及目录删除/替换、深度回退、取消后重新探测、超时、混合计划回滚/前滚、外来文件冲突、旧 helper 门控、v2 cache 协议与 cache 损坏、目录 cache 复用/结构变化回退、scoped visible leaf 枚举，以及 128／129 个父目录的边界。

本轮独立只读审查已完成，并补充了 racy cache 标记、退出清理和复用分支的确定性测试。旧 helper 在混合计划中仍可能先准备 pack 再回退，存在额外准备开销；兼容性分类与平台发布覆盖也仍需后续维护。
