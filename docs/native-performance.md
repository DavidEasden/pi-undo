# 原生目录扫描与普通文件恢复性能验证

## 快照复核的条件响应（以 84d08c9c 为基线）

同一工作区再次查询同一组整体忽略的目录时，支持 `scan-serve-leaf-digest-v1` 的助手仍按原流程复核目录并收集叶子。它按原生返回顺序对每个 UTF-8 路径及其 NUL 结束符计算 SHA-256；只有本次结果与客户端发送的摘要一致时，才省去完整路径列表。客户端只保留最近一组已校验的非空结果，最多 65,536 个路径、4 MiB 路径字节（含结束符）。未命中时仍校验完整响应；旧助手继续使用原协议。这不是工作区未变的证明，Git 对忽略规则、索引及分区边界的前后检查均不变。

基线复核不再为 Git 工作区创建未使用的临时索引。可见文件失配时直接回退完整捕获；可能复用基线时，并行检查私有 Git 对象和当前忽略路径，两项都结束后再做可见文件的最终复核。

macOS arm64 / APFS / Node 23.11.1，3,059 个目录、33,861 条忽略路径。两版使用同一工作区和独立临时 store，忽略路径先逐项对照 Git。每轮交替进行目录发现与 `captureBaseline`，验证返回各自原始清单；不在复核计时内重复发现拓扑。以下为中位数：

| 实际工作区，无文件变化 | 基线 | 本轮 |
| --- | ---: | ---: |
| 连续复核，预热两轮后各 11 次 | 255.4 ms | 211.5 ms |
| 连续检查，含目录发现 | 279.8 ms | 234.1 ms |
| 闲置 11.5 秒后的首次复核，各 3 次，不含闲置时间 | 270.9 ms | 221.4 ms |
| 连续复核时的叶子响应 | 2,753,810 字节 | 154 字节 |

真实 SDK 基准（10,000 个依赖包、修改 1 个文件，各 3 组，每组校验三次撤销和重做）：检查点就绪中位数从 321 降到 311 ms；首次 `/undo` 从 426 到 422 ms，小于组间波动。本轮能确认的是重复复核更快，不能据此推断首次撤销有相同比例的收益。

## 目录发现与快照复核（以 a9434d8d 为基线）

目录发现并行读取外层仓库信息和扫描子目录，两项都结束后才处理 gitlink。`capture` 在完整校验后冻结自己创建的清单、roots 和忽略路径数组。本实例再次收到这份原件时，不再验证清单自身的结构和摘要；仍重新取证并逐项对比工作区路径、文件指纹、忽略证明和 Git 对象。原件身份记录在 `WeakSet` 中，不延长清单生命周期。外部传入的清单、同 ID 的副本和 `loadManifest` 返回的对象都不享受这项豁免。完整校验时按分隔符检查路径前缀，避免为每个祖先反复拆分并拼接数组。

macOS arm64 / APFS / Node 23.11.1，同一工作区、相同的随包原生助手，两份独立的临时 store。工作区有 3,059 个目录、33,861 条忽略路径。先对照 `git ls-files --others --ignored --exclude-standard -z`，再各预热两轮。两版交替执行 `discover` 和 `captureBaseline`，每次均确认复用了本次捕获的原件；表中是各阶段耗时的中位数，总时长独立取中位数。

| 实际工作区，无文件变化 | 目录发现 | 快照复核 | 合计 |
| --- | ---: | ---: | ---: |
| 连续检查，各 7 次 | 36.0 → 24.2 ms | 326.3 → 249.6 ms | 362.3 → 274.2 ms |
| 闲置 11.5 秒后的首次检查，各 3 次，不含闲置时间 | 189.8 → 169.1 ms | 339.6 → 270.6 ms | 529.5 → 439.6 ms |

原生助手的闲置退出策略和叶子复核未改动。另试过在时间戳为整秒时逐目录核对实际目录项；在本项目 946 个此类目录上，直接请求同一批叶子的中位数反而从 76 增到 140 ms（各 5 次），未采用。

真实 SDK 基准 `PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts -t '10000 个依赖包，修改 1 个文件'` 交替执行三组，每组校验三次 undo/redo 的文件内容和历史栈。检查点就绪耗时 `[378,367,395]` → `[324,355,376]` ms；首次 undo `[466,460,487]` → `[425,461,468]` ms。此次测得的主要收益在检查点之前，首次 undo 的中位数差异小于组间波动。

## 常驻扫描响应按块分行（以 0bfae4d8 为基线）

助手可能把一份很长的 JSON 响应分成数百块发送。客户端现在只在新到的文本里找换行，完整行就绪时才拼接；同一块里下一条响应的开头会保留。32 MiB 上限仍按所有未消费的 UTF-8 字节计算，包含换行。助手闲置退出时间、目录复核和忽略规则不变。

macOS arm64 / Node 23.11.1 同机交替对照，表中为各阶段的中位数：

| 场景 | 基线 | 本轮 |
| --- | ---: | ---: |
| 实际叶子响应分行：2,753,713 字节、351 块，按相同边界回放 7 次，输出逐字比较 | 60.2 ms | 0.4 ms |
| 当前项目无变化时，目录发现加基线复核：33,860 条忽略路径，两份独立私有 store 预热后各测 5 次，每次验证快照等价 | 415.5 ms | 348.3 ms |
| SDK 基准：10,000 个依赖包，改 1 个文件，检查点就绪（各 3 组） | 368 ms | 335 ms |
| 同一 SDK 基准的首次 `/undo` | 464 ms | 469 ms |

收益主要出现在含大响应的检查点等待。SDK 用例每组执行三次撤销和重做并校验文件、历史栈；首次撤销未测到提速。

## 快照清单摘要缓存（以 2e13c6b4 为基线）

计算检查点的变更路径和准备撤销计划都会多次读取同一份清单。每个 `SnapshotStore` 现在按最近使用顺序保留最多 32 对清单 ID 和已验证的原始文件 SHA-256，不缓存 JSON 对象。每次仍从磁盘读取并解析；只有 ID 和字节摘要同时命中才复用结构与内容校验结果。文件被删除或损坏仍会报错；即使只改变 JSON 空白也会重新完整校验。Git 对象完整性和写入前的工作区复核不变。

macOS arm64、Node 23.11.1 上，只读重放同一对真实清单：前后分别有 32,398 和 33,570 条忽略路径，变更 5 个文件。两版交替运行 5 轮，逐次比对计划摘要及删除、写入路径。下表为中位数；首次是指新的 store 和恢复引擎，不清空操作系统页缓存。热读是在同一实例上重复该计算。

| 阶段 | 首次：基线 → 本轮 | 热读：基线 → 本轮 |
| --- | ---: | ---: |
| 检查点的变更路径计算（全量计划） | 479 → 339 ms | 466 → 214 ms |
| 撤销前准备计划（限 5 条路径） | 480 → 364 ms | 319 → 198 ms |

本对照不执行文件恢复，也不包含工作区扫描、等待 Agent 停止或事务落盘；不能把表中差值当作整次 `/undo` 的提速。

## macOS 内容事件与目录缓存（以 2c650ba0 为基线）

macOS 常驻扫描现在保留两个确切事件组合下的目录缓存：`ItemIsFile | ItemModified`（`0x11000`），以及附带 `ItemInodeMetaMod` 的普通覆盖（`0x11400`）。内容事件既不标记父目录失效，也不推进目录变化代数，避免扫描末尾再次排空事件时将其升级为完整重扫。只有工作区内的有效非空路径适用。

创建、删除、重命名、目录/符号链接变化、其他元数据标志、未知位、丢事件以及无效路径继续复核。合并批次中任一结构事件都保留；纯内容事件不会清除待处理变化。文件内容、执行权限、忽略规则、Git index 和仓库指针继续由上层读取。

刚创建的文件在首次覆盖时仍可能报告 `0x11500`，其中包含 `ItemCreated`，必须重新枚举父目录。撤销的暂存文件、重命名和硬链接也会产生结构事件。为避免把大量近期依赖目录的复核成本推迟到首次 undo，局部扫描增加受限分支：只有整批事件都属于已知普通文件变化，或确切的目录 inode 元数据变化时，才允许复用没有自身或后代事件的近期子树。复用前打开子树根目录，核验 dev/ino/mtime/ctime 和父子绑定；实际变化的目录仍重新枚举。深层文件变化必须沿祖先访问其真实父目录。目录创建/删除/重命名、符号链接、未知位以及事件不确定均退出该分支，继续原有 `racy` 复核。Linux 不启用这个分支；共享盘回退和持久缓存加载规则不变。

### 完整监听覆盖下复用近期子树

上一节只覆盖了普通文件事件。目录创建/删除/重命名仍会因 `racy` 时间戳窗口重新枚举整棵近期依赖树：独立实验中新增一个目录耗时 650 ms。这次增加进程级监听信任：macOS 的 FSEvents 从握手开始监听，若本次进程从未报告丢事件、未知类型、越界路径、路径数量超限或监听异常，就允许局部扫描越过 `racy` 窗口，直接复用没有自身或后代事件的子树，不再打开子目录。实际变化的祖先和目录仍逐层枚举，父子绑定仍校验。

信任一旦丢失就永久降级：任何 loss flag、无法解析的事件路径、未知文件类型、`changedPaths` 超限或监听线程停止，都把该进程标记为不可信，后续批次退回原 `racy` 复核。Linux 的 inotify 路径不启用该信任。持久缓存加载后的初始完整扫描仍要求非 `racy`，因此进程重启后的第一次扫描不受影响；信任只作用于本次进程内已建立监听之后的事件扫描。

独立 helper 实验中，同一棵 20,002 目录、刚创建的依赖树上新增目录与文件：650 → 24.6 ms。内容覆盖保持 15 ms 左右，无变化 15.5 ms。SDK 基准的检查点为 321 ms，与上一节的 322 ms 相同；这是因为检查点的目录发现本就只占 17 ms，收益主要体现在结构事件和大量新建目录后的扫描，而不是这个夹具的检查点。

这与前面的内容事件修正共享同一取舍：信任依赖 FSEvents 对结构变化的完整投递，已知丢失路径都有 loss flag 兜底；若平台发生无标志的静默丢失，可能漏掉一次结构变化。因此该分支仅在 macOS、且本次监听从未降级时启用，事件不确定时仍完整重扫。

SDK 原基准在创建依赖后才创建待修改文件，保留这一默认场景。另加 `PI_UNDO_BENCH_EXISTING_FILES=1` 测量已有文件覆盖：先创建待修改文件，等待 2.1 秒，再创建依赖目录。依赖目录仍形成近期缓存；等待在夹具准备阶段，不计入检查点耗时。两种夹具分别做同机 A/B，首次 undo/redo 单独记录，避免将成本转移误报为提速。

同机验证使用 macOS arm64 / APFS / Node 23.11.1 / Rust 1.94.0 / Pi SDK 1.4.0。基线和本轮使用相同基准文件、同一工具链构建 helper，交替顺序运行三组；每组有 10,000 个忽略文件、20,002 个目录，只修改一个可见文件。检查点和首次操作取三组中位数；后续操作取每组第 2、3 次共六个样本的中位数。每次 undo/redo 都断言文件内容和历史栈。

| 指标 | 原 SDK 夹具：基线 → 本轮 | 已有文件夹具：基线 → 本轮 |
| --- | ---: | ---: |
| SDK `agentSettled()` 到检查点可用 | 1,133 → 334 ms | 1,143 → 341 ms |
| 首次 undo | 652 → 654 ms | 650 → 663 ms |
| 后续 undo | 318 → 318 ms | 315 → 322 ms |
| 首次 redo | 538 → 545 ms | 531 → 552 ms |
| 后续 redo | 538 → 538 ms | 529 → 537 ms |

检查点三组原始值：原夹具 `[1142,1133,1132]` → `[325,334,349]`，已有文件夹具 `[1133,1143,1153]` → `[341,350,341]`。原夹具首次 undo `[640,652,652]` → `[656,649,654]`，已有文件夹具 `[650,637,658]` → `[693,663,633]`。检查点等待减少约 70%，未证明 undo/redo 提速；已有文件场景部分操作的中位数略增。原夹具本轮后续 undo 六个样本为 `[599,317,313,319,314,330]`，其中一次为 599 ms，不能仅凭中位数宣称所有操作延迟均不变。

独立 helper 实验中，覆盖已有文件后的目录扫描三组中位数为 620 → 17 ms，三次均从 `cacheHits:false` 变为 `true`；再次覆盖为 389 → 16 ms。根目录新增文件为 182 → 18 ms，仍为 `cacheHits:false`，因为实际重读了父目录。新增目录与文件为 650 → 24.6 ms。无变化为 18.52 → 18.53 ms。以上收益针对近期创建的大目录树，不代表所有成熟工作区都有同等提速；目录结构变化仍可能触发较大范围复核。

最终 macOS 完整套件通过 729 项，Linux arm64 / ext4 完整套件通过 731 项；启用了 resident live 用例，平台和按需基准导致跳过数不同。Rust 测试分别通过 29 和 27 项，两平台类型检查与本机打包检查通过。macOS 禁用 native 的套件通过 674 项，10,001 文件删除用例超过 180 秒；隔离复跑在 177.7 秒通过，保留这项耗时敏感性。Rust LSP 未能运行：本机工具链缺少 `rust-analyzer`，可用 `rustup component add rust-analyzer` 补装；编译和 Rust 测试已执行。更新了仓库中的 macOS/Linux arm64 helper；其他架构由发布矩阵构建，本机未执行。

```sh
cargo test --locked --manifest-path native/pi-undo-fs/Cargo.toml
PI_UNDO_RUN_RESIDENT_LIVE=1 npx vitest run test/resident-live.test.ts test/ignored-leaves.test.ts
PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts -t '10000 个依赖包，修改 1 个文件'
PI_UNDO_LARGE_WORKSPACE=1 PI_UNDO_BENCH_EXISTING_FILES=1 npx vitest run test/large-workspace.test.ts -t '10000 个依赖包，修改 1 个文件'
```

## 精确忽略叶子复用（以 5bf6b54a 为基线）

这次把常驻目录扫描已读取的文件/符号链接名称保存到 cache，并通过 `scan-serve-leaves-v1` 按需返回。持久 cache schema 升到 3；旧 schema 丢弃后重建，旧 helper 不接收新字段。每次获取叶子都重新排空事件、核验 workspace 身份、更新发生变化的目录；没有用操作作用域、根目录时间戳或过期时间代替子树变化检查。

叶子复用只用于 Git 本次确认“整个目录忽略且没有 index 条目”的分区。分区祖先清单、目录绑定、忽略规则和 index 在前后继续核验；部分忽略目录、范围捕获和未分出的路径仍使用 Git 精确查询。符号链接只记录自身，不跟随目标。仓库标记、特殊项、重复路径、跨设备子树、协议错误、数量或字节预算超限都放弃叶子复用。只在本次验证的 macOS APFS 和 Linux ext 文件系统启用；其他文件系统、旧 helper、禁用 native 时沿用原枚举。

### 先验证事件失效边界

以下操作完成后立即请求扫描，没有为变化增加等待；结果对照实际目录树。叶子接入后的集成测试另把每次 manifest 的 `ignoredPresentPaths` 与 `git ls-files --others --ignored --exclude-standard -z` 逐项比较。

| 场景 | macOS APFS | Linux ext4 |
| --- | --- | --- |
| 无变化 | 复用缓存 | 复用缓存 |
| 深层文件增删、深层 Git 标记增删 | 更新受影响目录 | 更新受影响目录 |
| 移入已有子树、移动后继续变化、移出、重命名 | 检测变化 | 检测变化 |
| 目录替换为外部符号链接 | 只返回链接自身 | 只返回链接自身 |
| helper 重启期间发生变化 | 先逐目录校验持久 cache | 先逐目录校验持久 cache |
| 同一操作作用域内两次捕获之间新增深层文件 | 第二份证明包含新路径 | 第二份证明包含新路径 |
| 叶子返回后改变忽略规则或 index | 原分区失效，重新取证 | 原分区失效，重新取证 |
| 事件丢失/覆盖不完整 | loss flags、路径预算等注入测试要求完整校验 | 实际队列溢出后拒绝旧进程，重建监听 |

Linux 队列溢出暴露了旧实现的正确性问题：暂停 helper 后创建/删除 18,000 次文件，再创建新子树，第一次请求会完整重扫，但新子树没有 watch；随后新增 `.git` 会错误命中旧缓存。现在队列溢出、卸载、意外 watch 丢失、监听遍历失败等状态不再恢复成“无事件”，客户端丢弃进程并重建完整监听。复测包含溢出后的第二次变化，已检测到新增标记。已知的目录删除会先清理 watch 映射，正常删除不会被误判成永久丢失。

共享盘另做宿主机写入实验：macOS 创建深层文件后，Linux 能立即读取文件，inotify 事件字节数为 0。因此 FUSE 继续禁用常驻快路径，不能把“没收到事件”解释成“文件没变化”。

### 同机交替 A/B

macOS arm64 / APFS / Node 23.11.1；Ubuntu 24.04.3 arm64 虚拟机 / ext4 / Node 24；Pi SDK 1.4.0。两侧 helper 均用各平台同一工具链从对应源码构建，顺序执行三组，交换先后顺序。工作区含 10,000 个忽略文件、20,002 个目录。热捕获和 baseline 每组取五轮中位数，再取三组中位数；SDK 每组修改 1 个文件，执行三次 undo/redo 并断言内容和历史。

| 指标 | macOS 基线 → 本轮 | Linux ext4 基线 → 本轮 |
| --- | ---: | ---: |
| 热完整捕获（不含目录发现） | 368 → 137 ms | 393 → 51 ms |
| 热 baseline 检查（不含目录发现） | 344 → 113 ms | 383 → 45 ms |
| SDK `agentSettled()` 到检查点可用 | 1,402 → 1,125 ms | 2,994 → 218 ms |
| undo（每组三次的中位数） | 326 → 320 ms | 218 → 217 ms |
| redo（每组三次的中位数） | 531 → 532 ms | 328 → 328 ms |
| 首次完整捕获（不含目录发现） | 1,711 → 1,715 ms | 2,902 → 2,899 ms |

热完整捕获的三组中位数分别为：macOS 基线 `[377,365,368]`、本轮 `[138,137,135]`；Linux 基线 `[382,400,393]`、本轮 `[50,53,51]`。baseline 分别为 macOS `[353,344,344]` → `[113,110,113]`、Linux `[376,393,383]` → `[44,46,45]`。检查点等待分别为 macOS `[1405,1402,1386]` → `[1124,1125,1129]`、Linux `[2994,3007,2969]` → `[209,226,218]`。

主要收益是检查点证明，未证明 undo 或稳态 redo 提速。Linux 每组首次 redo 从 `[336,319,319]` ms 增至 `[435,446,423]` ms，增加约 100 ms；后两次 redo 的合并中位数约 329 → 325 ms。保留这项回归，不把后三次中位数当作所有操作都没有代价。首次捕获仍要建立精确证明，未见改善。

Linux Parallels FUSE 上另做一次 3,000 包、修改 1 文件的同挂载回退对照：检查点 608 → 624 ms，undo 651 → 632 ms，redo 527 → 531 ms；这些差异不足以证明提速。该夹具的工作区和会话目录都在共享盘，运行代码在虚拟机本地盘。

10,000 叶子的独立 helper 稳态 RSS 单次采样：macOS 23.17 → 26.91 MiB，Linux 19.73 → 23.88 MiB；持久目录 cache 分别从 3.38 → 3.71 MiB、3.26 → 3.58 MiB。新增叶子清单约增加 4 MiB 驻留内存，不涉及文件内容缓存。

### 验证与复现

macOS 完整套件通过 725 项、禁用 native 通过 675 项；Linux 完整套件通过 728 项、禁用 native 通过 677 项。平台能力和按需基准导致跳过数不同。新增 benchmark 默认跳过；最终边界修正另跑受影响测试。Rust 测试 macOS 23 项、Linux 26 项全部通过；两平台类型检查、打包检查通过。共享盘额外执行规则/index 变化和嵌套分区的两个回归用例，均通过。

```sh
npm run build:native
# 将产物复制到本平台对应的 native/bin/pi-undo-fs-<平台>-<架构> 后运行。
npx vitest run test/ignored-leaves.test.ts test/native-directory-scan.test.ts
PI_UNDO_IGNORED_BENCHMARK=1 npx vitest run test/ignored-proof-benchmark.test.ts
PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts -t '10000 个依赖包，修改 1 个文件'
```

两类基准均支持 `PI_UNDO_BENCH_REPORT` 追加 JSONL；忽略证明基准可用 `PI_UNDO_BENCH_PACKAGES=3000` 调整规模。通过 `TMPDIR` 控制夹具挂载，临时目录必须位于工作区之外。本轮更新仓库已有的 macOS/Linux arm64 二进制；其他架构和 Windows 未在本机执行，继续由发布矩阵构建。

## Linux 共享盘

Linux arm64、Node 23.11.1、Pi 1.4.0 SDK。工作区和会话目录均放在同一 Parallels `fuse.prl_fsd` 挂载上。3,000 个 ignored 依赖包（6,002 个目录），每次只覆盖一个根目录文件。表中为每组连续三次操作的中位数；成功的用例同时断言文件内容与 undo/redo 栈。

| 同一挂载上的配置 | 撤销 | 重做 |
| --- | ---: | ---: |
| `c73bd40f` 默认 | `recovery_required`，无有效耗时 | 未执行 |
| `c73bd40f` 全局禁用 native | 5.54 s | 3.75 s |
| 仅将 FUSE 覆盖切换到事务日志 | 5.58 s | 5.35 s |
| 同时按目录项扫描，首次 / 复测 | 3.27 / 3.90 s | 3.25 / 3.88 s |

失败的单文件用例在 `renameat2(RENAME_NOREPLACE)` 处返回 `EINVAL`。现在在预制 pack 和真正应用计划前，分别用 `statfs` 检查待覆盖普通文件的父目录（去重、有界并发）；Linux FUSE 或无法判断时，整批走原有 WAL。它是保守的挂载类型判断，不是在用户目录创建文件做能力探测；纯新增、纯删除不依赖这次 rename，保留原选择。已进入 mutation 的事务仍使用原恢复流程，不在失败后换实现。

工作区根位于 Linux FUSE 时不启动 `--serve`，TypeScript 每次完整枚举目录，从枚举结果挑选可能含 `.git` 的目录再检查，不对每个普通目录单独查询 `.git`。仍遍历 ignored 目录，并在枚举前后复核目录路径。两次实测每轮撤销均执行两次拓扑发现。这组撤销基准早于下述检查点优化。未在 Windows 或其他 FUSE 驱动上实测，不把本机数据当作性能保证。

复现：将 `TMPDIR` 指向共享盘上工作区外的临时目录，运行 `PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts -t '3000 个依赖包，修改 1 个文件'`。不指定 `TMPDIR` 时夹具通常在 `/tmp` 建工作区，测不到共享盘。

### 共享盘检查点

基线为 `b33e2d90`（0.4.1）；两侧在同一 Linux arm64 虚拟机顺序运行，工作区均在 `/media/psf`。指标分开统计，以下不是 `/undo` 的执行时间：

| 场景 | 基线 | 优化后 |
| --- | ---: | ---: |
| 当前项目，93 个可见文件、48,210 个忽略文件，无修改，目录发现＋baseline 验证（三次中位数） | 6,745 ms | 3,415 ms |
| Pi 1.4.0 SDK，3,000 个依赖包、改 1 个文件，`agentSettled()` 到检查点可用（两侧各一次） | 6,689 ms | 3,304 ms |

第一组直接调用 `discover` 和 `captureBaseline`，独立私有 store，先做一次不计时的完整捕获。基线三次 `[6730, 6745, 6769]`，最终 `[3333, 3756, 3415]`；每次复用同一 manifest。第二组使用上一节的复现命令，报告字段为 `checkpointMs`，另经三轮撤销和重做验证文件内容与历史。首次完整快照仍需要 Git 精确枚举，不计入上述时间。

只把上次忽略文件数量作为选择执行方式的提示。满足阈值的 Linux 共享盘完整根，每次用 `check-ignore` 检查顶层目录本身（`dir/*` 不等于 `dir/`），再用 `ls-files --cached` 排除强制跟踪项。整体忽略的目录分批重新读取，只收集文件和符号链接，不跟随链接；其他项仍交由 Git 和原有 metadata 校验。扫描前后复核根目录清单、忽略规则结果和 index。遇到仓库标记、范围排除、特殊目录项、路径预算或无法确认的状态，就使用原查询；取消、超时不会启动重试。没有缩短等待超时，也没有提前发布检查点。

### ignored-present 证明路径按实测成本选择

上一轮的分区扫描只对 Linux FUSE 工作区启用：构造函数仅在 `process.platform === "linux"` 时建立规模集合，`captureIgnoredPresentPaths` 还额外要求 `allowsNativeMountFastPaths(cwd)` 为假。

本轮先在 macOS 本地盘上把它解禁，测到稳态 `baselineValidation` 从约 255 ms 降到约 145 ms。但在 Linux 上复核时发现同一改动造成回退——结论是「哪条路径更快」并不由平台决定：

| 环境 | `ls-files --others --ignored`（3,000 文件） | 分区枚举（目录项缓存命中） |
| --- | ---: | ---: |
| macOS arm64 本地 APFS | 约 180–200 ms | 约 222 ms |
| Linux arm64 本地 ext4 | 约 22–35 ms | 约 80–150 ms |
| Linux arm64 Parallels FUSE | 约 4,590 ms | 约 200 ms |

Git 的 `--ignored` 查询在 ext4 上比分区快、在 APFS 上略快、在 FUSE 上慢二十倍。任何按平台写死的选择都会在其中两种环境上吃亏，因此改为运行时采样：

- 有完整样本时选实测更快的一侧，且要求分区明显更快（`partitionMs * 1.1 < gitMs`），避免在噪声区间反复摇摆。
- 样本不全时交替采集，先 Git 后分区各一次；FUSE 例外，那里 Git 精确查询慢两个数量级，不能为了采样先付这一次。
- 只在完整根（`inclusions` 与 `exclusions` 都为空）上采样，且两类样本必须对应同一覆盖面——分区成功时 Git 只查剩余的 `rest`，不能当作完整查询的基准。
- `SnapshotStoreOptions.ignoredProofPath` 仅供测试固定路径，跳过自适应。

三环境实测（3,000 依赖包、改 1 个文件，`discover` 加 `captureBaseline`，稳态 `baselineValidation`）：

| 环境 | 原实现 | 本轮 |
| --- | ---: | ---: |
| macOS arm64 本地 APFS | 253–262 ms | 259–269 ms |
| Linux arm64 本地 ext4 | 62–66 ms | 61–63 ms |
| Linux arm64 Parallels FUSE | 193–214 ms | 214–221 ms |

三处都落在原实现的波动区间内。本轮不声称提速，只把路径选择从平台猜测改为实测，让 macOS 与 Linux 用户都不再因平台判断而拿到较慢的一侧；FUSE 上的快路径保持不变。

分组计时中 `captureIgnoredPresentPaths` 占完整捕获的八成，其中 `ls-files --others --ignored` 占绝大部分，native metadata inspect 约 30 ms，`write-tree`、`read-tree` 与对象完整性各为个位数毫秒。分区路径把前者换成 `check-ignore`（约 6 ms）加目录枚举。

「解禁即提速」这个早期结论不成立：当时的 138 ms 来自目录项缓存已热的特定测量顺序，无法在干净会话复现。未在 Windows 启用（保留原查询）。

### 目录项缓存复用

共享盘上单次 `readdir` 约占目录扫描耗时的九成，`realpath` 约一成，提高并发（8→64）只从 1,937 ms 降到 1,684 ms。因此改为在同一 `RootDiscovery` 实例内缓存目录项：每次仍先 `lstat`，`dev`、`ino`、`mtime`、`ctime` 全部不变，且缓存时目录最后修改早于枚举时刻超过 2 秒，才复用上次结果，否则重新 `readdir`。枚举前后元数据不一致的结果不进入缓存。`realpath` 边界复核每次照常执行。ignored 目录扫描使用同一缓存，所以检查点的根发现与完整捕获、撤销前后的两次拓扑发现，都不再重复读取相同目录。

同一共享盘、3,000 个依赖包、修改 1 个文件，单次运行：

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| `checkpointMs` | 3,142 ms | 512 ms |
| 撤销三次 | `[3142, 3128, 3129]` | `[692, 625, 626]` |
| 重做三次 | `[3104, 3113, 3124]` | `[468, 463, 468]` |

每轮撤销仍执行两次拓扑发现，并验证文件内容与历史栈。首次扫描和目录变化后的扫描仍是完整读取。秒级时间戳的文件系统依赖 2 秒窗口避免漏检。

### 忽略叶子类型复用目录项缓存

`captureIgnoredPresentPaths` 的 Git 查询只负责给出路径，类型仍要证明。此前每次都启动 native `--inspect-batches` 进程：本项目的 7,649 条候选约 240 ms，即使目录项缓存已持有同样的 file/symlink 信息。

现在先按父目录查 `DirectoryListingCache`。只有目录列表 `stable` 且已离开 racy 窗口时，才用条目名对应的 kind；任一父目录缓存缺失、枚举期间变化或仍在 racy 窗口，就整体回退到 native 或逐路径 `lstat`。复核按目录去重：祖先链与目录身份（`dev`/`ino`）各验证一次，不再为每条叶子重走路径；根目录（空键）不参与相对路径校验。

当前项目（97 个可见文件、48,215 个忽略文件、4,945 个目录，无修改），同一时间窗口交替运行时 `agentSettled` 到检查点：

| 版本 | 三次 | 中位数 |
| --- | --- | ---: |
| `v0.4.6` | 1363 / 1335 / 1367 ms | 1363 ms |
| 本改动 | 1229 / 1251 / 1220 ms | 1229 ms |

稳态结算仍复用 baseline，`ignoredPresentPaths` 由单元测试对照 Git 精确查询验证。首次捕获和目录刚变化时仍在 racy 窗口，继续走 metadata 进程；这条路径没有提速。共享盘单次运行差异较大，上表只代表同一窗口内的成对样本。

### 嵌套忽略目录与完整证明计时

本项目的 `native/pi-undo-fs/target/` 不在顶层。以 `8225521a` 为基线，分区后仍有 7,649 条路径交给 Git 枚举和类型复核，其中 7,646 条都在这个目录里。现在用有界的 `git ls-files --others --ignored --directory` 查找候选，仅展开候选的祖先，从实际目录清单生成互不重叠的正向 literal pathspec。即使提示遗漏，未分出的路径仍由 Git 精确枚举。只把经 `check-ignore` 确认整体忽略且无 index 条目的目录交给现有扫描器，文件和符号链接仍逐项写入 `ignoredPresentPaths`。

提示输出上限为 64 KiB；普通探测失败时仍可尝试顶层分区。各展开层合计超过 512 项或 24 KiB 参数预算、遇到仓库边界，或在剩余 Git 查询后发现分区清单、目录绑定、忽略分类、索引检查结果发生变化时，丢弃分区结果，重新精确枚举。取消、超时、进程退出未确认不会触发回退。自适应选路现在计时到完整叶子列表排序结束，包含剩余查询和类型复核；尝试分区后回退的开销也计入分区侧。Windows 和有范围限制的捕获仍走原查询。

同一 Linux Parallels 共享盘工作区，无文件修改，两版使用独立 store，每轮交替先后顺序。首次精确捕获和首次分区采样不计入热运行：

| 指标 | `8225521a` | 嵌套分区 |
| --- | ---: | ---: |
| Git 剩余精确查询的叶子数 | 7,649 | 3 |
| 完整 ignored 证明（5 次中位数） | 770 ms | 391 ms |
| 根发现＋`captureBaseline`（另测 5 次中位数） | 1,357 ms | 826 ms |

完整证明五次分别为 `[770, 749, 883, 728, 826]` 和 `[391, 436, 369, 477, 366]` ms，每次与 Git 全量精确查询的 48,215 条叶子逐项相同。另测 `captureBaseline` 时保留返回前的拓扑复核，各轮均复用了原 manifest。这是本机热工作区的数据，不代表冷启动、其他文件系统或整次撤销的加速比。

## 历史基准

本轮实现目录项缓存与 scoped restore 的可见路径检查；普通一次性扫描仍会逐个打开、核验工作区内的目录，宽目录最多使用 16 个有界 worker 并行处理。常驻 `--serve` 在 macOS 上使用 FSEvents 收集变更父目录，只重新枚举受影响祖先并合并局部 cache；无变化请求复用驻留 cache，事件丢失、监听停止或扫描竞争时回退完整校验。

## Durable pack 准备与批量写入

`createDurablePack` 的第三个参数和 `prepareDurableRestore` 的第四个参数支持可选的 `onTiming(phase, durationMs)` 与 `onDiagnostics(diagnostic)`。阶段标签包括 `prepare.plan`、`prepare.blobs`、`prepare.entries`、`pack.validate`、`pack.encode`、`pack.write`、`pack.sync`、`pack.publish`、`pack.checksum`、`pack.resident`、`prepare.pin`、`prepare.index` 和 `prepare.total`。其中 `prepare.total` 是完整准备时间，不能与各分阶段时间相加。默认 SnapshotStore 的 `prepare.plan` 包含对象完整性检查和 blob 预取；自定义 store 的兼容逐文件读取会计入 `prepare.entries`。计时在相应阶段成功结束时报告；没有可预制计划或发生异常时，不报告完整准备成功时间。

数量诊断报告 entries、fileVariants、payloadBytes、packBytes 和 writeCalls，不包含路径、内容或 operation ID。writeCalls 统计实际发起的 FileHandle 写入调用，包含短写重试，不代表操作系统内部 syscall 数量。诊断回调异常不会改变生成结果；这些回调可供基准或调用方采集，默认不另行写入运行时诊断文件。

写入使用最多 256 个 buffer、最多 4 MiB 的 `writev` 批次。单个大 header 或 payload 会切成视图分批写入，不拼接整包；空 payload 不发起写入。短写按实际写入字节数推进，覆盖 buffer 内、边界和跨 buffer 的情况；零进展、无效长度和 I/O 错误会失败。批次之间及发布前检查操作取消。持久化顺序仍为临时文件写完、文件同步并关闭、rename、父目录同步；发布前失败清理临时文件并保留已有 pack。

v1 格式不变。`test/fixtures/durable-pack-v1.bin` 由本轮批量写入之前的串行写入器生成，SHA-256 为 `d11a4364cee3b347116cf8c3f6cc598baddc593b778f3ee81f24568546f57b4e`；测试验证旧文件可加载，并且新写入器对同一输入产生逐字节一致的文件。原有损坏 pack 拒绝加载、native restore 和 packed recovery 测试继续覆盖恢复流程。

本机 macOS arm64 基准以 `a02dd580` 加入相同计时后的串行写入为基线，再只替换写入策略进行对比。每个场景冷、热缓存各三次，下面为完整 `prepareDurableRestore` 的中位数，单位毫秒；不包含造数、capture、apply 和清理。冷缓存指新 SnapshotStore/RestoreEngine 的进程内缓存，不清空操作系统页缓存；热缓存指同实例再次准备相同 pack。

| 场景 | 串行写入 | 批量写入 | 变化 |
| --- | ---: | ---: | ---: |
| 10,001 个文件，每版本 64 字节，冷缓存 | 2,503 | 2,267 | 降低约 9.4% |
| 同上，热缓存 | 1,310 | 1,075 | 降低约 17.9% |
| 8 个文件，每版本 4 MiB，冷缓存 | 265 | 275 | 增加约 10 ms |
| 同上，热缓存 | 187 | 196 | 增加约 9 ms |

小文件的串行写入调用为 20,005 次，批量写入为 81 次；写入阶段从约 233–239 ms 降到约 6–11.5 ms。大文件从 19 次变为 17 次，没有证明性能改善。小文件三次完整准备耗时分别为：基线冷 `[2517, 2503, 2488]`、热 `[1311, 1278, 1310]`；批量冷 `[2321, 2196, 2267]`、热 `[1075, 1094, 1052]`。这些是本机合成基准，不设 CI 墙钟门槛，不等同于完整 undo/redo 的收益。

基准还输出结束时 RSS 和整个测试进程的峰值 RSS；后者包含造数、capture 和所有前序样本，不能当作单次 prepare 的峰值。本批次整体高水位约为基线 824 MiB、批量 932 MiB，未证明内存改善。本轮只限制单次写入规模，仍保留原有的整批 payload 持有和复制策略，未实现流式 pack 构建。

```bash
PI_UNDO_PACK_BENCHMARK=1 npx vitest run test/durable-pack-benchmark.test.ts --reporter=verbose
npx vitest run test/durable-pack.test.ts test/durable-pack-write.test.ts test/packed-recovery.test.ts test/native-restore.test.ts
```

### Scoped plan 的冷 blob 校验复用

plan 额外报告 `plan.validate`、`plan.complete`、`plan.paths`、`plan.diff` 四段计时，分别对应入口校验、对象完整性与预取、路径展开、差异与计划生成。它们属于 `prepare.plan` 内部阶段，不能重复累加。按需基准同时记录 Git 子命令的次数与累计耗时；新旧两侧查询可能并行，Git 累计耗时也不能直接当作 plan wall-time。

带 scope 的完整性检查现在一次性将去重后的 blob 分为两组：缓存命中的 blob 与根 tree 继续用 `cat-file --batch-check` 检查磁盘；冷 blob 用原有按字节和数量分批的 `cat-file --batch` 同时完成校验与预取。每个读取响应仍验证 object ID、blob 类型、tree 中记录的长度、内容边界、条目顺序和无多余字节。冷 blob 不再先做一次仅查询类型/大小的检查，然后再读取相同对象。没有 scope 的完整性检查保持原来的完整 batch-check。

分组后不再按缓存状态重新过滤读取列表，防止其他请求在窗口内填入缓存后跳过本次磁盘校验。热缓存中的内容不能掩盖磁盘 blob 丢失；失败仍抛出 `object_missing`。测试覆盖冷热缓存对象缺失、并发填充、重复 blob 去重、scope 与路径归属，以及 missing、错误类型/ID/长度、截断和额外输出。

后续独立对比以 `29bdc0c7` 加相同分阶段诊断为基线，在两个 worktree 顺序运行相同基准，每组各三次。这里只比较本轮 scoped 校验变化，不与上面的批量写入收益累加：

| 场景 | 本轮基线 | 校验复用后 |
| --- | ---: | ---: |
| 10,001 个小文件，冷缓存完整准备 | 2,386 ms | 2,079 ms（减少约 12.9%） |
| 同上，仅 plan | 1,763 ms | 1,456 ms（减少约 17.4%） |
| 10,001 个小文件，热缓存完整准备 | 1,160 ms | 1,168 ms |
| 8 个大文件，冷缓存完整准备 | 281 ms | 281 ms |
| 8 个大文件，热缓存完整准备 | 201 ms | 201 ms |

小文件冷缓存三次完整准备耗时分别为基线 `[2370, 2386, 2401]`、优化后 `[2144, 2079, 2061]`。冷缓存仍有两次根 tree batch-check 和十次分块 blob 读取；减少的是两份检查请求中重复查询的 20,002 个 blob，不是省掉这些 blob 的读取与验证。热缓存仍完整检查全部所需对象，没有证明提速。测试进程整体峰值 RSS 约为基线 897 MiB、优化后 904 MiB，未证明内存改善；这仍包含造数、capture 和前序样本。

### Tree 范围合并、blob 有界并发与 pack 私有副本

对 `6a00f83d` 的进一步分析将 tree 查询拆成路径匹配与大小查询：10,001 个小文件的单次 Git 查询，带全部路径和大小约 459 ms；去掉路径列表约 228 ms；全量只列 tree 不查大小约 10 ms。这里是独立 Git 查询，不包含 capture、JS 解析或完整准备。

本轮保留以下三项优化：

- 大 scope 先在公共父目录内执行只列名称的探测，仅将完全受 scope 覆盖的目录合并为一个 literal pathspec。非 Windows 从 4,096 条路径起尝试，Windows 从 512 条起尝试；较小 scope 保持原查询。探测输出按 scope 字节数限制，最少 64 KiB、最多 2 MiB。超限、普通 Git 失败或无效提示回退精确查询；取消、超时和未确认进程退出不触发回退。最终结果及路径归属缓存仍按原 scope 过滤，未探测的祖先不能作为合并目标。`ls-tree -l` 的大小查询继续保留，以维持后续读取的字节预算。
- blob 仍按最多 2,048 个对象（Windows 为 256 个）、16 MiB 分批。只有所有批次都不超过 8 MiB 时才允许两路并行，因此每个读取任务的在途 payload 总预算仍不超过 16 MiB。大批次与超限单文件保持串行；一批失败后等待其他在途任务结束，并停止调度剩余批次。4,096 对象批次的实验没有显示足以保留的额外收益。
- pack 在校验前取得输入的私有副本，编码、写入和内存驻留共享这份副本；对外读取文件内容仍返回副本。调用方在诊断回调或异步写入期间改写输入，不会改变磁盘 pack 或驻留内容。SHA-256 直接同步读取 Uint8Array 有效区间，去掉计算 checksum 前的整段复制。v1 格式和原子发布顺序保持不变。

相同基准在基线与最终实现的两个 worktree 中顺序运行，每个场景冷、热各三次，以下为毫秒中位数。冷缓存仍指新 SnapshotStore 的内存缓存；各轮历史结果不合并计算：

| 场景 | `6a00f83d` | 本轮最终实现 |
| --- | ---: | ---: |
| 10,001 个小文件，冷缓存准备 | 1,938 | 1,526（减少约 21.2%） |
| 同上，仅 plan | 1,346 | 951（减少约 29.3%） |
| 10,001 个小文件，热缓存准备 | 1,099 | 1,103 |
| 10,001 个文件仅修改 1 个，冷缓存准备 | 84 | 87 |
| 同上，热缓存准备 | 72 | 72 |
| 8 个大文件，冷缓存准备 | 262 | 258 |
| 同上，热缓存准备 | 191 | 185 |

小文件冷缓存三次为基线 `[1980, 1922, 1938]`、最终 `[1560, 1526, 1511]`。热缓存、稀疏修改和大文件没有证明稳定提速。未充分覆盖目录的稀疏大 scope 可能增加一次有界探测开销；超过探测预算时回退精确查询，不复用部分结果。

本轮真实 Pi 1.3.0 SDK、10,000 个 ignored 依赖包场景此前分别进行了三次 undo/redo，验证每次内容、历史状态和五次拓扑发现；该数据记录的是当时版本，不代表当前复用 durable source 的扫描次数。耗时中位数如下：

| 场景 | undo 基线 → 最终 | redo 基线 → 最终 |
| --- | ---: | ---: |
| 修改 1 个文件 | 2,649 → 2,285 ms | 2,386 → 2,394 ms |
| 修改 100 个文件，首次对比 | 2,030 → 2,314 ms | 1,954 → 2,474 ms |
| 修改 100 个文件，反向运行顺序复测 | 2,343 → 1,894 ms | 2,468 → 1,939 ms |

100 文件首次 undo 原始样本为基线 `[2030, 2555, 1885]`、最终 `[2702, 2314, 1863]`；反向顺序复测为基线 `[2011, 2802, 2343]`、最终 `[2692, 1838, 1894]`。两轮结果方向不同，因此没有证明端到端稳定提速，也不把准备阶段的 21.2% 外推到完整 undo/redo。复测留下的末次操作诊断中，plan 为 52/51 ms，而 apply 为 1608/1099 ms；当前小 scope 的主要耗时与波动仍在其他恢复阶段。

独立内存基准每次新开测试进程，输入为 64 MiB payload，在阶段边界记录相对入口的内存增量，分别运行三次。额外 ArrayBuffer 观测高值由约 124 MiB 降至 64 MiB；额外 RSS 由约 123 MiB 降至 67 MiB。它们不是整个进程的瞬时峰值，也不包含 SnapshotStore capture。输入与私有 payload 仍整体驻留，本轮没有实现流式 pack 构建。

```bash
PI_UNDO_TREE_BENCHMARK=1 npx vitest run test/tree-query-benchmark.test.ts
PI_UNDO_PACK_MEMORY_BENCHMARK=1 npx vitest run test/durable-pack-memory-benchmark.test.ts
PI_UNDO_PACK_BENCHMARK=1 npx vitest run test/durable-pack-benchmark.test.ts
PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts -t '10000 个依赖包'
```

## 性能诊断与批次调优

metadata inspect 默认每批最多处理 2,048 条路径，并受 1 MiB 路径请求字节上限约束。可使用 `PI_UNDO_METADATA_BATCH_MAX_PATHS=4096` 或 `8192` 做受控基准测试；有效范围为 1 到 8,192，超出范围会拒绝本次 capture。路径字节上限不会被环境变量覆盖，用于限制长路径工作区的单批请求规模。

操作诊断文件中的 native helper 现在按 `native:scan-directories`、`native:metadata-inspect`、`native:restore` 等稳定标签区分，并记录捕获到的输出字节数。诊断仍不记录路径、请求内容或 helper 输出正文，可用于比较 helper 启动次数、耗时和输出规模。

当前实现仍为“一批一个 helper 进程”；本轮没有引入常驻 helper 或多请求协议。只有在批次调优数据确认进程启动成本占主要比例后，才进入协议改造。

在本机 macOS arm64、Node 23.11.1、10,000 个依赖包且修改 1 个文件的 SDK 基准中，默认 2,048 批次三次耗时为 `[2437, 2440, 2426]` ms，中位数 `2437 ms`；设置 4,096 批次后三次为 `[2425, 2438, 2432]` ms，中位数 `2432 ms`。差异约 `0.2%`，低于该基准的运行波动，因此没有把默认批次提高到 4,096。两组扫描次数都为 `[5, 5, 5]`，峰值 RSS 分别为约 `260 MiB` 和 `279 MiB`；RSS 未显示出提高批次上限的收益。

GitRunner 会对单次 Git stdout 应用 256 MiB 硬上限；超过上限时终止整个 Git 进程组并抛出 `git_output_limit`，避免在 `Buffer.concat(...).toString()` 阶段触发 Node.js `ERR_STRING_TOO_LONG` 或无界内存增长。正常的 blob batch 读取仍按 16 MiB 分批，不受该上限影响。

- `scan-directories-v2` 在 macOS/Linux 上缓存每个目录的 `dev/ino/mtime/ctime`、Git 标记和直接子目录。一次性 helper 及常驻服务的完整回退路径仍核验全部目录；常驻 macOS 服务收到可靠 FSEvents 后只重新枚举变更父目录和祖先，其他未受影响子树按 cache 整体复用。宽目录按最多 16 个 worker 分批并行，避免为每个目录创建线程。直接命中的 racy 目录不会被局部路径直接复用，而是重新枚举。
- 缓存把 racy 标记固化到记录中，以开始枚举目录前的观察时刻计算两秒窗口。长子树扫描或之后的时间流逝不会让旧的 racy 记录自动变成可信记录。时间戳纳秒部分为零、无效或处于未来时采取保守重扫。
- 扫描继续进入 ignored 目录，以发现其中的嵌套仓库；不进入名称恰为 `.git` 的元数据目录，不跟随 symlink。目录句柄、父子绑定和工作区身份检查保留。超过 128 层时丢弃原生部分结果，由 TypeScript 从根重扫。
- v2 cache 绑定工作区路径与身份，结构解析失败或不匹配时不复用。它位于工作区外的私有临时目录，位置检查会解析 `TMPDIR` 的符号链接；无法安全放置请求时使用 TypeScript。cache 创建失败时使用本次请求目录，cache 写入失败不使成功扫描失败。正常进程退出时尽力清理，强制终止仍可能留下系统临时文件。
- 能力探测一次取得 capability 集合；旧 `scan-directories-v1` helper 继续完整扫描，缺少 helper 时使用 TypeScript。扫描仍受操作剩余时间和 `PI_UNDO_OPERATION_TIMEOUT_MS` 限制，取消或未确认退出保持原有处理契约。
- `listVisibleLeafPaths` 支持 `includePaths`。带 scope 的 complete restore 只枚举 scope 内的可见叶子；scope 外新增文件保留，scope 内新增可见路径仍会在修改前阻止恢复。未指定 scope 的完整恢复继续枚举整个工作区。嵌套仓库边界、内容、mode、symlink、mutation journal 和 quarantine 检查保留。
- 常驻 `--serve` 在 macOS 上使用带 file events 的 FSEvents stream，按事件路径归并到父目录；事件 dropped、路径无法解析、监听线程停止或扫描前后仍有新事件时回退完整扫描。事件取样有短暂 settle 窗口，以覆盖文件操作刚完成但系统尚未投递事件的情况；Linux/Windows 仍使用现有回退路径。

缓存信任应用进程创建的私有文件及操作系统提供的目录元数据，不提供跨整个工作区的原子快照，也不提供抵抗同用户篡改 cache 的完整性保证。

## 本轮前后对比

环境：本机 macOS arm64、Node 23.11.1、Pi 0.86.1 SDK、离线 faux provider。基线为本轮改动前的 `bbe5c3f8`；基线和最终实现分别在隔离 worktree 中顺序运行相同用例，均使用原生 helper。每组执行三次 undo，中间 redo 并等待后台持久化清理，校验文件内容、历史状态和扫描次数。

| 场景 | 本轮改动前 | 本轮改动后 | 耗时降低 |
| --- | ---: | ---: | ---: |
| 10,000 个依赖包，修改 1 文件 | 2,792 ms | 2,504 ms | 10.3% |

基线三次耗时为 `[2970, 2792, 2763]` ms，最终实现为 `[2497, 2504, 2529]` ms；两组扫描次数都为 `[5, 5, 5]`。上述百分比只比较本轮前后，没有把更早版本的收益算入本轮。强制 TypeScript 回退也通过同一大型工作区用例，扫描次数为 `[6, 6, 6]`；额外一次来自无法复用原生 durable source 时重新捕获安全快照。

此前开发中一次 v2 采样为 `[2443, 2423, 2419]` ms；它与最终对比属于不同批次，不合并计算。三次本机采样只能说明这一基准的表现，没有墙钟性能断言，也没有对用户实际 50GB 项目、其他平台或其他磁盘作出速度保证。

## 本轮追加：撤销前序准备与拓扑扫描

真实 Pi SDK、10,000 个 ignored 依赖包、单文件变更的三次 undo/redo 基准中，改动前 undo 中位数为 2,150 ms、每次 3 次完整拓扑发现；改动后中位数为 1,745 ms、每次 2 次发现。单次诊断中 safety 阶段从 504 ms 降至 90 ms：当 `changedPaths` 全部是叶子且工作区内容逐项匹配 checkpoint source 时，直接复用 source manifest；目录 scope、内容不匹配或无法证明时仍走原 scoped safety capture。运行时持有 workspace lock 后，visible-pre 的可见路径校验保留，但跳过其后的重复 topology 扫描；`restore-pre` 和 `restore-post` 两次检查仍保留。上述为本机样本，墙钟数据会受扫描缓存和负载影响，不构成其他工作区的速度保证。

## 私有 ODB 合并、父目录校验与 pack 内存

本轮不改恢复语义，只处理五类剩余成本：私有快照库长期保留 loose object、恢复路径上的两处 O(n²)、native metadata inspect 的重复父目录校验、常驻扫描重启后的冷启动，以及 durable pack 的整份 payload 副本。

### 私有 ODB 定期合并 loose object

私有仓库显式关闭了 `gc.auto` 与 `maintenance.auto`，此前没有任何 repack 路径，capture 写入的 blob/tree 会一直以 loose object 保留。`cat-file --batch-check` 与 `cat-file --batch` 因此需要逐个打开 loose 文件。

现在 `captureBaselineLocked` 在完整 capture 结束后检查 `git count-objects -v`，满足以下条件才合并：

- loose 对象达到 4,096 个或 256 MiB；
- 该状态已持续至少 5 分钟（首次越阈值只写 `pi-undo-compact.json` 观察时间，不立即 repack）；
- 距离上次检查至少 60 秒（`count-objects` 在 2 万对象库上约 80–100 ms，不能每次 settle 都付）。

真正执行时按磁盘上的 loose object 列表调用 `git pack-objects`，再 `git prune-packed`。私有仓库没有 refs，`git repack -a` 不会把 manifest 引用的对象视为可达，因此不能直接使用 repack。维护窗口与 capture 共用 store 锁，调用方（settled capture）同时持有 workspace 独占锁；维护失败不影响已经完成的 capture。维护耗时单独报告为 `settled.compact`，不计入 `settled.fullCapture`。默认阈值可通过 `SnapshotStoreOptions.compactMinLooseObjects` / `compactMinAgeMs` 调整，`compactMinLooseObjects: 0` 表示禁用。

**为什么延迟 5 分钟**：A/B 复测发现“立即合并”会让大改动后的第一次 undo 变慢。10,000 个文件全部修改、settle 完整 capture 后再 `prepareDurableRestore` 的本机结果：

| 方案 | settle（含维护） | prepare（含 plan + pack） | 合计 |
| --- | ---: | ---: | ---: |
| 基线（不合并） | 3,997 ms | 2,490 ms | 6,487 ms |
| 立即合并（旧版本轮实现） | 6,074 ms（其中 repack 2,666 ms） | 1,140 ms | 7,214 ms |
| 延迟合并（当前实现） | 3,651–3,684 ms（检查约 134 ms） | 1,728–1,775 ms | 5,379–5,459 ms |

立即合并虽然把 `plan.complete` 从约 930 ms 降到约 299 ms，但 repack 成本（20,403 个对象约 2.7 s，其中 `prune-packed` 约 1 s）被提前到刚写完这批对象的时候，单次流程反而更慢。延迟到 5 分钟后，repack 摊销到后续多次 plan/verify：每次 undo 约省 600 ms，约 4–5 次后收回成本。

合并前后（10,000 个内容各异的文件，真实 `SnapshotStore`）：

| 指标 | 合并前（loose） | 合并后（packed） |
| --- | ---: | ---: |
| `assertComplete`（10k blob） | 331 ms | 49 ms |
| `readBlobs`（10k blob，含 manifest 复验） | 443–966 ms | 158 ms |
| `count-objects` | `count: 10202, in-pack: 0` | `count: 0, in-pack: 10205` |

### 本轮端到端 A/B 复核

基线为合并前的 `ce0b71e5`；两侧在隔离 worktree 中顺序运行同一用例。

**大型工作区（10,000 个依赖包，修改 1 个文件）**：每次调用 3 次 undo/redo，三次调用结果：

| 指标 | 基线 | 本轮 |
| --- | ---: | ---: |
| undo 中位数 | 345 / 343 / 335 ms | 367 / 337 / 328 ms |
| redo 中位数 | 565 / 563 / 567 ms | 636 / 569 / 561 ms |
| 扫描次数 | 2 / 2 / 2 | 2 / 2 / 2 |

差异在运行波动内，**没有证明该场景的端到端提速**。该场景的可见文件只有 2 个，扫描已是常驻 13–20 ms 稳态，本轮改动主要作用在 10k 文件的捕获/校验路径，不改变这条主耗时。

**durable pack 准备（10,001 个文件全部修改，冷/热各三次）**：

| 场景 | 基线 | 本轮 | 变化 |
| --- | ---: | ---: | ---: |
| 冷缓存完整准备 | 2,598 / 2,449 / 2,431 ms | 1,697 / 1,666 / 1,666 ms | 约 -32% |
| 热缓存完整准备 | 1,852 / 1,852 / 1,808 ms | 1,039 / 1,060 / 1,060 ms | 约 -43% |
| `prepare.blobs` | 892–978 ms | 148–173 ms | 约 6× |
| `plan.complete`（loose） | 约 900 ms | 约 900 ms | 不变 |

主要收益来自 `readBlobs` 的 `Set` 去重（10k 唯一 blob 的 `Array.includes` 约 100 ms）与 `MutationPathIndex`；`plan.complete` 只有在 ODB 合并后才从约 930 ms 降到约 299 ms。

**native metadata inspect**：10,000 个深路径（20,001 个父目录）从 111.5–112.8 ms 降到 68.3–72.3 ms；10 个路径的小请求 4.25–4.27 ms → 4.16–4.32 ms，加入“小于 64 个父目录保持串行”后没有回归。

**常驻扫描**：20,002 个目录的 serve 冷启动 377 ms、带持久缓存 251 ms、稳态 13–20 ms。该收益在进程重启/长空闲后才体现；同一 session 内的连续 discover 本来就是稳态。

**racy 窗口 baseline 探测**：A/B 中强制 `skipBaselineProbe` 时 `settled.baselineValidation` 从 530 ms 降到 0 ms；实际只在 restore 后 2 秒内的下一次 settle 生效，不是每轮都有的收益。

### 恢复路径的 O(n²)

- `MutationPathIndex`（`src/path-safety.ts`）：`reusableTargetPaths` 原实现对每个 target path 重新展开 `[...deletePaths, ...writePaths]` 并线性扫描，10k × 10k 时约 962 ms。现在一次构建精确集合与排序列表，单次判定近 O(log n)，同数据形状 < 1 ms（构建 1.6 ms）。语义与 `mutationPath === path || mutationPath.startsWith(path + "/") || path.startsWith(mutationPath + "/")` 逐项等价，随机集合差分测试覆盖。
- `SnapshotStore.readBlobs`：同一 ODB 内的对象 ID 去重从 `Array.includes` 改为 `Set`，10k 个唯一 blob 从约 101 ms 降到 2.2 ms。该路径会在 durable pack 预制的 source/target 两个方向各执行一次。

### native metadata inspect 父目录校验

`inspect-batches` 原来按 batch 各自构建 `BTreeSet<PathBuf>` 父目录集合并前后各校验一遍；10,000 个 `node_modules/pkg/lib/index.js` 会收集 20,001 个父目录、执行 40,002 次 `lstat`。现在：

- 路径校验与父目录收集在整个请求内共享，parent 集合用 `HashSet<&str>` 借用请求中的路径字符串，避免为每个祖先分配 `PathBuf`；
- 父目录校验用与叶子 stat 相同的 32 路并发执行，前后仍然各一次；
- 保留原有 symlink/非目录诊断；macOS 上 `O_NOFOLLOW|O_DIRECTORY` 对 symlink 返回 `ENOTDIR` 的差异不再影响判定，因为改为直接 `lstat`。

本机 10k 深路径（20,001 个父目录）`--inspect-batches`：111.7 ms → 71.0 ms，约 36%；平铺 10k 路径的基线仍约 20 ms。

### 常驻扫描的持久缓存与闲置超时

`--serve` 握手新增可选 `cachePath`。启动时读取一次性扫描使用的 v2 目录缓存作为初始 `previous`，每个目录仍逐项核验元数据，漂移会重新枚举；初始扫描结束后把最终目录表原子写回，供下一次进程启动复用。闲置超时从 60 s 提高到 600 s，TS 客户端从 70 s 提高到 610 s，避免间歇使用时反复付冷启动。

本机 20,002 个目录：

| 场景 | 初始扫描 |
| --- | ---: |
| serve 冷启动（无缓存） | 377 ms |
| serve 使用持久缓存启动 | 251 ms |
| serve 稳态请求（无变化/单文件变化） | 13–20 ms |

### settled 的 baseline 探测

restore 成功后 2 s 内的 racy-clean 窗口内，文件 ctime 尚未稳定，`isBaselineFresh` 必然返回 false，但仍会完整执行 `assertObjectsComplete`、`collectVisibleLeaves`、ignored proof 和叶子复核。调用方在这个窗口内传入的 baseline 已确定失效，因此 `CaptureOptions.skipBaselineProbe` 直接进入 fullCapture。

控制器只在 `changedPaths.length > 0` 的 restore 后记录 target baseline；空 changedPaths 的 session-only undo 不写文件，探测仍可能成功，不跳过。多文件工作区实测 `settled.baselineValidation` 约 227–240 ms，本改动把这部分从结算路径上移除（诊断中保留 0 ms 阶段）。

### durable pack 的内存副本

`createDurablePack` 默认仍在校验前复制 payload，保证调用方之后改写输入不影响磁盘与驻留 pack。`restore-engine` 的 blob 来自本次操作独占的 store 读取，两个生产调用点改用 `payloadOwnership: "transfer"`，pack 直接引用这些 buffer。`loadDurablePack` 也不再为每个 variant 复制 payload，而是共享同一次 `readFile` 的 subarray，`leaf()` 返回时再复制。pack checksum 改为在 `writeAll` 按实际写出的字节增量计算，发布后不再完整遍历 payload。

本机独立进程 64 MiB payload 基准（阶段边界观测，不是瞬时峰值）：

| 模式 | 额外 ArrayBuffer | 额外 RSS | `pack.checksum` |
| --- | ---: | ---: | ---: |
| copy（默认/旧行为） | 64.0 MiB | 66.8 MiB | 24 ms |
| transfer（生产路径） | 0.01 MiB | 2.3 MiB | ~0 ms |

`PI_UNDO_PACK_MEMORY_TRANSFER=1` 可复现 transfer 数值；输入 buffer 本身仍由调用方持有，因此该表只表示 pack 阶段的额外增量。

### 仍未处理：ignored-present proof 的全量枚举

当时 `captureIgnoredPresentPaths` 每次完整 capture 仍执行 `git ls-files --others --ignored --exclude-standard`。本机 10,000 个 `node_modules` 忽略文件约 363 ms（`--directory` 可降到约 30 ms，但会丢失具体路径，无法直接替代 proof）。复用旧 proof 需要证明 ignored 子树的目录项集合未变，因此该轮只完成了 native inspect 优化。本文开头的“精确忽略叶子复用”现已通过新 helper 能力与 cache schema 实现此方向；忽略规则和 index 仍实时复核。

### 测试与复现

新增覆盖：MutationPathIndex 随机差分、readBlobs 重复请求只发一次 batch、`skipBaselineProbe` 直接完整捕获、自动 loose object 合并与阈值以下不重写 pack、transfer 所有权与 copy 逐字节一致且 `leaf()` 仍返回副本、serve handshake 的 cachePath（`PI_UNDO_RUN_RESIDENT_LIVE=1` 冒烟用例）。

```bash
npm run build:native
cp native/pi-undo-fs/target/release/pi-undo-fs native/bin/pi-undo-fs-darwin-arm64
npm run test:native
npm test
npm run typecheck
PI_UNDO_PACK_MEMORY_BENCHMARK=1 npx vitest run test/durable-pack-memory-benchmark.test.ts
PI_UNDO_PACK_MEMORY_BENCHMARK=1 PI_UNDO_PACK_MEMORY_TRANSFER=1 npx vitest run test/durable-pack-memory-benchmark.test.ts
PI_UNDO_RUN_RESIDENT_LIVE=1 npx vitest run test/resident-live.test.ts
PI_UNDO_MEMORY_BENCHMARK=1 npx vitest run test/resident-memory-benchmark.test.ts --reporter=verbose
```

### Pi runtime 驻留内存基线

`test/resident-memory-benchmark.test.ts` 以独立 Vitest 进程分别运行 SDK-only 测试夹具与启用 pi-undo 的 10,000 个 ignored 依赖包工作区，采集 workspace 建立后、SDK 初始化、pi-undo warm-up、run、undo/redo 和操作后的 idle 内存。报告包含 Vitest worker RSS、runner 进程树 RSS、native helper RSS，以及 Node heap、external 和 ArrayBuffer；Node 在可用时显式 GC 后另记 retained 样本。worker RSS 包含 Vitest 与基准代码本身，不等同生产 Pi 进程的 RSS；runner 进程树 RSS 是各进程 RSS 相加，会重复计算共享内存页，应主要比较同口径结果，并查看 worker/helper 分项。

macOS arm64、Node 23.11.1 的一次采样：

| 阶段 | Pi SDK worker RSS | pi-undo worker RSS | native helper RSS |
| --- | ---: | ---: | ---: |
| SDK 初始化后 retained | 162 MiB | 161 MiB | 未启动 |
| pi-undo warm-up 后 retained | — | 174 MiB | 35 MiB |
| undo/redo 后 idle retained | 162 MiB | 183 MiB | 38 MiB |
| 操作期 worker 峰值 | — | 196 MiB | 峰值约 52 MiB |

操作后 Node worker 的 retained heap 约 49 MiB，external 约 5 MiB；操作后 runner-tree RSS 约 394 MiB，但该总和包含 Vitest runner 并重复计算共享页。此前在 Vitest worker 内只遍历它自己的子进程，漏掉了 sibling native helper；当前基准会在 macOS native 模式下断言 warm-up helper RSS 非零。

这组数据说明，SDK-only 测试夹具的 worker RSS 已约 162 MiB；该数字包含 Vitest 开销，不是生产 Pi 的独立测量，也说明几十 MiB 不能作为整个 Pi 进程的目标。当前扩展在该工作区上相对 SDK-only 夹具增加的 Node RSS 约 20–22 MiB，常驻原生 helper 另约 35–38 MiB。单次小文件操作没有覆盖大 payload 或大规模历史 pack；后续内存优化应继续测大型差异，并优先收紧/预算化缓存与 workspace 路径索引。

本轮未在本机验证 Linux、其他架构或 Windows 的构建与运行；发布仍依赖现有六平台构建流程。

## 上一轮原生优化的历史数据

下表保留上一轮以 `d7d80230` 为起点的结果，便于追踪原生扫描及普通文件恢复的收益；这些数据不是本轮缓存改动的前后对比。单位为毫秒。

| 场景 | 上一轮优化前 | 上一轮优化后 | 耗时降低 |
| --- | ---: | ---: | ---: |
| 无依赖目录，修改 1 文件 | 146 | 148 | 约持平 |
| 3,000 包，修改 1 文件 | 1,976 | 924 | 53% |
| 10,000 包，修改 1 文件 | 5,857 | 2,755 | 53% |
| 100 文件全部覆盖 | 179 | 182 | 约持平 |
| 100 文件在根目录新增后撤销 | 177 | 174 | 约持平 |
| 100 文件在已有子目录新增后撤销 | 517 | 180 | 65% |
| 50 文件覆盖、50 文件新增后混合撤销 | 711 | 186 | 74% |

上一轮分阶段计时中，3,000 包的五次扫描合计从 1,759 ms 降至 716 ms；10,000 包从 5,470 ms 降至 2,398 ms。另一批四组大型工作区测量覆盖 3,000／10,000 包 × 1／100 文件，中位数依次为 878、923、2,582、2,673 ms；这些独立批次不混算。

`restore-files-v2` 支持父目录已存在的普通文件覆盖、创建、删除和混合计划。`restore-files-v3` 在这一基础上允许变更散布于任意数量的父目录：helper 按最多 128 个非根父目录句柄切分批次，并在每批内依次完成 target 准备、source 隔离、target 安装和验证；跨批失败仍由同一 durable pack 执行恢复。单条路径超过 128 层、目录创建/删除、类型替换和不支持的旧 helper 继续使用 TypeScript。durable pack 格式及逐项内容/mode 校验、no-clobber 语义均未变化。

本轮追加验证了 130 个独立子目录的原生恢复及回滚，并对 10,001 个文件进行了两种本机合成 apply 基准：分散于 334 个包目录的混合恢复约 5.0 秒，根目录 10,001 个 delete-only 恢复约 10.2 秒；TypeScript 回退的前一组约 60.5 秒。上述数值仅用于同一台 macOS arm64 工作站上的路径对比，不是 CI 墙钟门槛或其他项目的性能保证。普通文件 10,001 项之外的负载形状、磁盘和平台可能不同。

## 复现与验证

本轮最终默认 Vitest：623 项通过、4 项按需基准跳过；Rust：12 项通过；原生相关 TypeScript：76 项通过。强制 TypeScript 回退完整测试和大型工作区用例、类型检查、npm 打包内容检查分别运行，不把跳过项算作通过。

```bash
npm run build:native
cp native/pi-undo-fs/target/release/pi-undo-fs native/bin/pi-undo-fs-darwin-arm64
npm run test:native
npm test
PI_UNDO_DISABLE_NATIVE=1 npm test
npm run typecheck
npm run pack:dry-run
PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts --testNamePattern='10000 个依赖包，修改 1 个文件'
PI_UNDO_DISABLE_NATIVE=1 PI_UNDO_LARGE_WORKSPACE=1 npx vitest run test/large-workspace.test.ts --testNamePattern='10000 个依赖包，修改 1 个文件'
```

二进制复制路径适用于本次 macOS arm64 环境；其他平台需要对应构建产物。本轮更新了仓库现有的 macOS arm64 二进制，未在本机验证 Linux、其他架构或 Windows 的构建与运行；发布仍依赖现有六平台构建流程。

测试覆盖目录缓存命中、深层 Git 标记新增、目录删除后的失效、racy 记录重扫、缓存身份与重复子项校验、TMPDIR 符号链接、v1/v2 协议、取消和超时，以及 scoped restore 保留范围外文件、拒绝范围内新增可见文件。独立只读审查已完成，审查提出的时间戳窗口、缓存清理和复用测试问题已修正；最终边界修正由主代理复核并重新验证。旧 helper 的混合计划仍可能先准备 pack 再回退，保留额外准备开销。
