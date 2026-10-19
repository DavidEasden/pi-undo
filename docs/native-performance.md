# 原生目录扫描与普通文件恢复性能验证

本轮实现目录项缓存与 scoped restore 的可见路径检查，保留恢复前后的拓扑校验。目录扫描仍会逐个打开、核验工作区内的目录；缓存减少 `readdir`，没有把整次检查变成只访问 changedPaths 的增量操作。

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

## 性能诊断与批次调优

metadata inspect 默认每批最多处理 2,048 条路径，并受 1 MiB 路径请求字节上限约束。可使用 `PI_UNDO_METADATA_BATCH_MAX_PATHS=4096` 或 `8192` 做受控基准测试；有效范围为 1 到 8,192，超出范围会拒绝本次 capture。路径字节上限不会被环境变量覆盖，用于限制长路径工作区的单批请求规模。

操作诊断文件中的 native helper 现在按 `native:scan-directories`、`native:metadata-inspect`、`native:restore` 等稳定标签区分，并记录捕获到的输出字节数。诊断仍不记录路径、请求内容或 helper 输出正文，可用于比较 helper 启动次数、耗时和输出规模。

当前实现仍为“一批一个 helper 进程”；本轮没有引入常驻 helper 或多请求协议。只有在批次调优数据确认进程启动成本占主要比例后，才进入协议改造。

在本机 macOS arm64、Node 23.11.1、10,000 个依赖包且修改 1 个文件的 SDK 基准中，默认 2,048 批次三次耗时为 `[2437, 2440, 2426]` ms，中位数 `2437 ms`；设置 4,096 批次后三次为 `[2425, 2438, 2432]` ms，中位数 `2432 ms`。差异约 `0.2%`，低于该基准的运行波动，因此没有把默认批次提高到 4,096。两组扫描次数都为 `[5, 5, 5]`，峰值 RSS 分别为约 `260 MiB` 和 `279 MiB`；RSS 未显示出提高批次上限的收益。

GitRunner 会对单次 Git stdout 应用 256 MiB 硬上限；超过上限时终止整个 Git 进程组并抛出 `git_output_limit`，避免在 `Buffer.concat(...).toString()` 阶段触发 Node.js `ERR_STRING_TOO_LONG` 或无界内存增长。正常的 blob batch 读取仍按 16 MiB 分批，不受该上限影响。

- `scan-directories-v2` 在 macOS/Linux 上缓存每个目录的 `dev/ino/mtime/ctime`、Git 标记和直接子目录。每次检查仍核验全部目录的身份与时间戳，匹配时才复用目录项。检查点之间发生变化的目录重新枚举；扫描期间发生变化则显式失败，不接受部分结果。
- 缓存把 racy 标记固化到记录中，以开始枚举目录前的观察时刻计算两秒窗口。长子树扫描或之后的时间流逝不会让旧的 racy 记录自动变成可信记录。时间戳纳秒部分为零、无效或处于未来时采取保守重扫。
- 扫描继续进入 ignored 目录，以发现其中的嵌套仓库；不进入名称恰为 `.git` 的元数据目录，不跟随 symlink。目录句柄、父子绑定和工作区身份检查保留。超过 128 层时丢弃原生部分结果，由 TypeScript 从根重扫。
- v2 cache 绑定工作区路径与身份，结构解析失败或不匹配时不复用。它位于工作区外的私有临时目录，位置检查会解析 `TMPDIR` 的符号链接；无法安全放置请求时使用 TypeScript。cache 创建失败时使用本次请求目录，cache 写入失败不使成功扫描失败。正常进程退出时尽力清理，强制终止仍可能留下系统临时文件。
- 能力探测一次取得 capability 集合；旧 `scan-directories-v1` helper 继续完整扫描，缺少 helper 时使用 TypeScript。扫描仍受操作剩余时间和 `PI_UNDO_OPERATION_TIMEOUT_MS` 限制，取消或未确认退出保持原有处理契约。
- `listVisibleLeafPaths` 支持 `includePaths`。带 scope 的 complete restore 只枚举 scope 内的可见叶子；scope 外新增文件保留，scope 内新增可见路径仍会在修改前阻止恢复。未指定 scope 的完整恢复继续枚举整个工作区。嵌套仓库边界、内容、mode、symlink、mutation journal 和 quarantine 检查保留。
- 本轮没有引入 FSEvents/inotify 变更索引，也没有消除 settled 阶段完整 baseline 的枚举成本。因此，目录很多或 baseline 捕获很慢的工作区仍可能有明显等待，不能据此保证用户的 50GB 项目达到秒级响应。

缓存信任应用进程创建的私有文件及操作系统提供的目录元数据，不提供跨整个工作区的原子快照，也不提供抵抗同用户篡改 cache 的完整性保证。

## 本轮前后对比

环境：本机 macOS arm64、Node 23.11.1、Pi 0.86.1 SDK、离线 faux provider。基线为本轮改动前的 `bbe5c3f8`；基线和最终实现分别在隔离 worktree 中顺序运行相同用例，均使用原生 helper。每组执行三次 undo，中间 redo 并等待后台持久化清理，校验文件内容、历史状态和扫描次数。

| 场景 | 本轮改动前 | 本轮改动后 | 耗时降低 |
| --- | ---: | ---: | ---: |
| 10,000 个依赖包，修改 1 文件 | 2,792 ms | 2,504 ms | 10.3% |

基线三次耗时为 `[2970, 2792, 2763]` ms，最终实现为 `[2497, 2504, 2529]` ms；两组扫描次数都为 `[5, 5, 5]`。上述百分比只比较本轮前后，没有把更早版本的收益算入本轮。强制 TypeScript 回退也通过同一大型工作区用例，扫描次数为 `[6, 6, 6]`；额外一次来自无法复用原生 durable source 时重新捕获安全快照。

此前开发中一次 v2 采样为 `[2443, 2423, 2419]` ms；它与最终对比属于不同批次，不合并计算。三次本机采样只能说明这一基准的表现，没有墙钟性能断言，也没有对用户实际 50GB 项目、其他平台或其他磁盘作出速度保证。

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
