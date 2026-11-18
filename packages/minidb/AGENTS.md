# minidb Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `packages/minidb`。

kap-server 搜索索引背后的嵌入式 JSON 文档库（`MiniDb`）：快照 + WAL 持久化，带独占写锁（抢锁失败的一方以只读方式打开，并从 WAL 追平；`OpenOptions.onLockAcquired` 在获取锁之后、开始恢复工作之前，立即报告所持有的锁 token。在 worker 线程里托管 MiniDb 的监管方需要它，因为 worker 线程与宿主进程共用同一个 pid，仅凭锁记录行里的 pid 无法驱动对失效锁的回收），外加一个支持超出内存数据量的全文检索层。

## 文本索引

`src/text-index/` 是倒排索引（内存中的词典 + 增量，磁盘上的倒排表在 `src/text-postings.ts`；模块围绕 `index.ts` 里的 `TextIndex` 核心，拆成 `tokenize.ts` / `types.ts` / `builder.ts` / `image.ts`），`tokenizer`/`queryTokenizer` 可注入；默认分词器保留 ASCII 单词和 CJK 的 uni/bigram，而 `src/trigram.ts` 提供哈希化的 2/3-gram 分词器（NFKC + 转小写，按码点开窗），用来支撑子串精确搜索。文本索引的定义（包括分词器名称）持久化在 `db.textindexes.json` 里。

## 代际与回退

派生状态（store 镜像、dt/二级/复合索引、文本词典 + 倒排表 + 文档表）以持久化的索引**代际**做检查点（`generations/g-NNNNNN/` + `CURRENT`，格式 v1；`src/generation.ts` 负责布局/清单，`src/gen-codec.ts` 负责二进制镜像）：写入方把代际构建到 `g-N.tmp-*` 目录里，再原子地发布（rename + 切换 CURRENT，严格 fsync）；每次压缩的轮转和代际发布构成同一个事务（取代了旧的同步 `rebuildTextPostings()` 收尾步骤）；打开时加载已发布的代际，再回放 WAL 增量，而不是重新解码每个值、重新对语料分词、重写倒排表（代际缺失、无效或版本未知时，完整恢复仍然是自动的**回退**路径；`OpenOptions.indexGenerations: false` 会强制走这条路径）。

在回退路径上，`open()` 内部不再等待语料规模的文本重建：它作为 `'text-build'` 维护任务，在同一个有界引擎上运行，并固定在恢复检查点上（回滚：`OpenOptions.deferOpenTextBuilds: false`）；在尚未提交的索引上搜索会抛出 `TextIndexBuildingError`（状态通过 `MiniDb.textIndexBuilding` 暴露；守卫条件是专用的 `basePending` 标志，所以在仍在服务的旧 base 之上做分阶段构建时，索引照常提供服务）；只读打开方则构建到 db 目录旁边的私有临时目录（`<dir>.ro-scratch/<pid>-*`，关闭时删除）里，并直接采用那里的磁盘 base，而不是在内存中聚合出完整的 base。异步 base 读取借助 base 切换纪元（`TextIndex.baseEpoch`）保证提交安全：跨越一次 base 提交的读取会从新的 base 重新读取，绝不缓存过期的列表。

健康的写入方在运行时也会一直保有一个有效的代际：每次写入时检查的 WAL 增长触发器（`MiniDb.maybeAutoGenerationBuild`，4 MiB 陈旧度规则，带节流和失败退避）覆盖了打开时那次触发覆盖不到的「从空库启动」窗口；`close()` 会尽力发布缺失或陈旧的代际（`buildGeneration('close')`）。加载时的完整性校验靠逐文件 crc32 + 定义哈希：镜像损坏或与定义不匹配时，用已加载的 store 只重建受影响的那个索引。整个打开路径都是协作式的（第 3 阶段，减轻主线程负担）：载荷校验分块进行并穿插让出（`readGenerationFileCheckedAsync`、`verifyFileIntegrityAsync`，错误语义与原来的同步版本相同）；store/镜像映射的构建做了切片（`Store.bulkLoadRefsAsync`（加载期间暂停主动过期定时器，所以加载中途的回收永远不会让映射与尚未重建的有序索引产生分歧）、异步镜像解析器、二级/复合索引的 `loadImageAsync`、`TextIndex.attachImageAsync`）；WAL 增量的应用按原语操作数 + 挂钟时间预算让出（`walApplySlicer`：一个批量帧会展开成数千个操作，所以按帧粒度让出永远无法限定单个切片的大小）。

打开阶段的生命周期遥测，即 `no-generation` / `generation-load` / `wal-catch-up` / `full-rebuild` / `ready` / `degraded` 状态机，加上各阶段的挂钟耗时（镜像加载、倒排表 crc、WAL 扫描/应用、完整恢复、文本重建及其托管方式），放在 `LifecycleTracker`（`src/lifecycle-status.ts`）里，由 `lifecycle.ts` / `generation-loader.ts` / `recovery.ts` 提供数据，通过 `MiniDb.lifecycleStatus()` 读取；`bench/open-lifecycle.ts`（`pnpm bench:open`）是覆盖四条打开路径（小语料、大 WAL 增量、大型全文检索代际、损坏的代际）的、可重复运行的事件循环延迟 / 输入延迟基线。

## 维护与 worker 构建

重量级维护通过统一的**维护调度器**运行（`src/maintenance.ts`：每个数据库同一时间只运行一个重任务、队列背压、磁盘剩余空间预检、截止时间/取消、关闭时排空或取消、`MiniDb.maintenanceStatus()` 读模型；任务内部发起的嵌套提交通过 AsyncLocalStorage 内联运行，以免自我死锁）。

全文检索代际的产物（分词 → 有界内存聚合 → 分段外部归并 → 倒排表/词典/base 文档）由 worker 构建**在主线程之外**产出（`src/worker/text-build-core.ts`，由 `src/worker/text-build.ts` + `src/worker/text-build-worker.ts` 托管：借助 `execArgv: ['--experimental-transform-types']` 使用 Node 原生的类型剥离，整个 worker 闭包里的导入说明符都显式带 `.ts`；worker 只在临时代际目录里写入，主线程负责校验（合理性检查 + 流式 crc），并在 `beginRebase` 之后通过 `TextIndex.commitRebase` 换掉在线的 base；`OpenOptions.textBuildWorker: false` 是回滚开关；worker 文件缺失时，在主线程上内联托管完全相同的有界核心；而 worker 槽位紧张时，会**先排队**等待一个进程级槽位（`WorkerSlots.acquireBounded`，等待上限为 `MiniDb.textBuildSlotWaitMs`，默认 30 秒，可响应中止），只有槽位持续短缺时，才把内联核心作为明确的最后手段来托管；线程内的分阶段聚合只保留给小语料（< 4096 个文档）、自定义函数分词器和显式回滚这几种情况）。同一个有界引擎（worker 或内联 + rebase，`MiniDb.boundedTextBuild`）也支撑两个全量语料的初次构建入口，即 `createTextIndex`，以及打开时加载器对损坏或与定义不匹配的镜像所做的重建；因此，给一个已有的大型 store 首次建索引时，不再在内存里聚合完整的 term->postings 映射。

## 异步读取接口

异步读取接口是附加的：`getAsync` / `searchAsync` / `searchBoundedAsync` / `queryAsync`（`ValueReader.readAsync`、`PostingsFile.readAsync`，以及通过 `TextIndexOptions.cacheBytes` 按字节限额的已解码倒排表缓存）；恢复扫描使用异步顺序扫描器（`scanFrameRefsFdAsync`：窗口化读取、切片 CRC、定期让出、AbortSignal、与同步扫描器共用的有界损坏重同步候选预算）；压缩的磁盘模式快照按 (file, offset) 给存活的引用分组，再用有界并发的异步定位读取读出（`src/snapshot.ts`）。只读副本的追平（`MiniDb.catchUpFromWal`）同样是协作式的：增量扫描复用同一个异步扫描器，应用阶段按原语操作数 + 挂钟时间预算让出（`walApplySlicer`），并且每个实例上的调用串行执行，重叠的追平绝不会在应用中途交错。落后很多的副本，不再因为一次同步的扫描 + 应用而卡住宿主的事件循环。
