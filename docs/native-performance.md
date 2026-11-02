# 原生目录扫描与普通文件恢复性能验证

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

`captureIgnoredPresentPaths` 每次完整 capture 仍执行 `git ls-files --others --ignored --exclude-standard`。本机 10,000 个 `node_modules` 忽略文件约 363 ms（`--directory` 可降到约 30 ms，但会丢失具体路径，无法直接替代 proof）。复用旧 proof 需要证明 ignored 子树的目录项集合未变，即把目录扫描的 cache 复用证据（或 FSEvents 代数）传递到 capture；这需要新的 helper 协议和缓存 schema 变更，本轮未实现，避免在恢复安全判定上引入未经复核的信任路径。当前只完成了同一条路径上 native inspect 部分的优化。

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
```

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
