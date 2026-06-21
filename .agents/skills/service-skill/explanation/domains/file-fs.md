# File / Fs / FileStore / WorkspaceFs 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

> 范围说明：ROADMAP M4.7 把 `fs` / `fileStore` / `workspaceFs` 放在同一个
> step 里确认边界。它们名字都带 “file / fs”，都触及“文件系统”，但**不是同一
> 个 domain**——本文先把它们拆清楚，再分别确认 query / command / runtime /
> 持久化各自落在哪一层，并说明为什么**不需要**代码拆分。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的文件访问流](#统一的文件访问流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，标题里的 “file / fs” 实际上是**三个相互独立的 service 表面**，跨
**两个半 domain**，共享 “在磁盘上读 / 写 / 列文件” 的直觉，但真相、键、作用
域、副作用、对外入口都不同：

- **fs domain（会话内文件操作）**：在**某个 session 的 cwd 内**对项目树做
  read / list / stat / mkdir / search / grep / git status / git diff /
  watch。键是 `(sessionId, relPath)`，所有路径经 `resolveSafePath` 约束在
  `session.metadata.cwd` 内（拒绝绝对路径、`..`、逃逸、越界 symlink）。
  - **query（查询）**：`IFsService.list` / `read` / `stat` / `listMany` /
    `statMany`（`fs.ts` / `fsService.ts`）+ `IFsSearchService.search` /
    `grep`（`fsSearch.ts` / `fsSearchService.ts`）+ `IFsGitService.status` /
    `diff`（`fsGit.ts` / `fsGitService.ts`）。
  - **command（命令）**：`IFsService.mkdir`（fs domain 对 daemon / SDK 的**唯
    一写入**；其余方法都是只读 / 解析）。
  - **runtime（运行时）**：`IFsWatcher` / `FsWatcherService`（`fsWatcher.ts`
    / `fsWatcherService.ts`）——connection-scoped 的活订阅，按
    `(connectionId, sessionId)` 持有 chokidar watcher，debounce / coalesce 后
    经 `FsWatcherDeliverySink` 投递 `event.fs.changed` 帧。这是 fs domain 的
    活状态 owner。
  - **infrastructure（基础设施，非 service）**：`resolveSafePath` /
    `FsPathEscapesError`（`fsPathSafety.ts`）——被 fs 各 query / command 共用的
    路径安全 helper，不是 `*Service`。
- **fileStore domain（全局 blob 存储）**：上传文件的**持久化 blob 库**。键是
  不透明的 `fileId`（`f_<ulid>`），blob 落在 `<env.homeDir>/files/<fileId>`，
  元数据索引在 `<env.homeDir>/files/index.json`。**不**按 session 作用域、**不**
  受 cwd 约束、**不**做路径安全校验（消费者拿不到路径，只拿到 `fileId` +
  `blobPath`）。
  - **query（查询）**：`IFileStore.get(fileId)` → `{ meta, blobPath }`。
  - **command（命令）**：`IFileStore.save(source, filename, options)` /
    `delete(fileId)`。
  - 它本质上是一个 **repository / blob-store contract**（持久化真相反映为磁
    盘 blob + `index.json`），只是按 service-skill 的“daemon / SDK facade”形
    状暴露为顶层 `IFileStore`。
- **workspaceFs（workspace 的 browse / home 表面）**：**不是独立 domain**，而
  是 **workspace aggregate** 的“浏览宿主文件系统以挑选 workspace root”的读表
  面。它在 `services/workspace/` 下，输入是**绝对路径**（`browse(absPath?)`，
  非绝对路径抛 `WorkspaceFsNotAbsoluteError`），**不**按 session 作用域、**不**
  受 cwd 约束——它存在的目的恰恰是让用户在**还没有 session / cwd 之前**就能
  浏览宿主磁盘、选择 workspace root。
  - **query（查询）**：`IWorkspaceFsService.browse(absPath?)` / `home()`。
    `home().recent_roots` 派生自 `IWorkspaceRegistry` 的最近打开列表。
  - **command**：无。workspace 的写表面（注册 / 重命名 / 删除 / root 解析）
    是 `IWorkspaceRegistry`，与 workspaceFs 的读表面在同一 workspace domain
    内分工。
  - 它已被统一的 `IWorkspaceService` facade（`workspace.ts` /
    `workspaceService.ts`）吸收：`IWorkspaceService.browse` / `home` 直接委托
    给 `IWorkspaceFsService`。遗留的 `IWorkspaceFsService` 契约保留给现有消费
    者。

**三者不是同一个 domain，也不需要进一步拆分。** 边界当前就是干净的：

- `services/fs`（fs domain）只做**会话内、受 cwd 约束**的文件操作 + 活订阅，
  不碰上传 blob、不做绝对路径浏览。
- `services/fileStore`（fileStore domain）只做**全局 blob 持久化**，不知道
  session / cwd / 项目树，不做路径安全校验。
- `services/workspace/workspaceFsService.ts`（workspace domain 的 browse /
  home 表面）只做**绝对路径浏览 + home + 最近 root**，不写文件、不持订阅、
  不知道 session。

**关系一句话：fs 是会话内文件操作 domain（query + 单写 command + runtime
watcher + 路径安全基础设施），fileStore 是全局 blob 持久化 domain（query +
command 的 repository contract），workspaceFs 是 workspace aggregate 的
browse / home 读表面（query-only，已被 `IWorkspaceService` 吸收）。三者共享
“文件系统” 的直觉但不共享真相、不共享键、不共享作用域，不应合并；当前代码已
按目录 / 层物理分离，无需拆分。**

接口 / 实现落点见 `services/fs/fs.ts` 的 `IFsService`（fs query + command
facade）、`services/fs/fsService.ts` 的 `FsService`（实现）、
`services/fs/fsSearch.ts` 的 `IFsSearchService`（fs 搜索 query）、
`services/fs/fsGit.ts` 的 `IFsGitService`（fs git query）、
`services/fs/fsWatcher.ts` 的 `IFsWatcher` / `FsWatcherService`
（fs runtime watcher）、`services/fs/fsPathSafety.ts` 的 `resolveSafePath`
（路径安全基础设施）、`services/fileStore/fileStore.ts` 的 `IFileStore`
（fileStore query + command）、`services/fileStore/fileStoreService.ts` 的
`FileStore`（实现 + blob + `index.json` 持久化）、
`services/workspace/workspaceFs.ts` 的 `IWorkspaceFsService`（workspace
browse / home query）、`services/workspace/workspaceFsService.ts` 的
`WorkspaceFsService`（实现）、`services/workspace/workspace.ts` 的
`IWorkspaceService`（统一 facade，吸收 browse / home）。本文只承载跨
Service 的概念叙述。

## 第一性原理

### 1. “file / fs” 这个词指代三件不同的事，不是单一 domain

“fs” 在代码里同时指三件键 / 作用域 / 真相完全不同的事：

- **fs（会话内文件操作）**：在某个 session 的 `metadata.cwd` 里读写项目文件。
  键是 `(sessionId, relPath)`；真相是磁盘上的项目树；每次调用经
  `ISessionService.get(sessionId)` 取 cwd，再经 `resolveSafePath` 把
  `relPath` 约束在 cwd 内。生命周期跟随 session（cwd 一变，所有相对路径的含
  义跟着变）。
- **fileStore（全局 blob）**：上传文件的持久化库。键是 `fileId`；真相是
  `<env.homeDir>/files/<fileId>` blob + `index.json`；与 session / cwd 完全
  无关。生命周期由上传 / 删除驱动，blob 可设 `expires_at`。
- **workspaceFs（workspace 浏览）**：在宿主磁盘上按**绝对路径**浏览目录 +
  取 home / 最近 root。键是 `absPath`；真相是宿主文件系统（无 cwd 约束）；用
  于 session 创建**之前**的 workspace root 选择。生命周期与 workspace 注册
  表绑定（`recent_roots` 派生自 `IWorkspaceRegistry`）。

因此它们不是 “一个 file domain 的三个角色”，而是**两个独立 domain（fs /
fileStore）+ workspace aggregate 的一个读表面**。把它们合并成一个 “file /
fs domain” 会混淆三种完全不同的键（`sessionId+relPath` / `fileId` /
`absPath`）、作用域（cwd 内 / 全局 / 宿主绝对路径）和真相（项目树 / blob
库 / 宿主磁盘）。

### 2. fs 是会话内文件操作 domain，query / command / runtime 各就其位

fs domain 的五个文件对应 service-skill 角色表里的三个角色 + 一个基础设施：

| 角色 | 契约 | 实现 | 职责 |
|---|---|---|---|
| query | `IFsService`（`list` / `read` / `stat` / `listMany` / `statMany` / `resolveDownload` / `resolvePath`） | `FsService` | 会话内项目树的只读读模型 + 路径解析 |
| query | `IFsSearchService`（`search` / `grep`） | `FsSearchService` | 文件名 / 内容搜索（spawn 子进程） |
| query | `IFsGitService`（`status` / `diff`） | `FsGitService` | git porcelain / numstat 解析 |
| command | `IFsService.mkdir` | `FsService.mkdir` | 会话内**唯一**写操作 |
| runtime | `IFsWatcher` | `FsWatcherService` | connection-scoped 活订阅 + `event.fs.changed` 投递 |
| infrastructure | `resolveSafePath` / `FsPathEscapesError` | `fsPathSafety.ts` | 路径安全约束（非 service） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md)
的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才
引入”。

- **fs 的 query 已经是三个 service 上的只读方法。** `list` / `read` /
  `stat` / `search` / `grep` / `status` / `diff` 全部无副作用，scope 固定为
  单 session（每个方法第一个参数都是 `sessionId`），无跨 session 读模型。它
  们**就是** fs domain 的 query 角色，按职责（核心 / 搜索 / git）拆成三个
  service 是**实现内聚**，不是角色分裂——再抽一个统一的 `IFsQueryService`
  反而把核心 IO / 子进程搜索 / git 解析三种实现压进一个接口。
- **fs 的 command 只有 `mkdir` 一个方法。** 它是 fs domain 对 daemon / SDK
  的唯一写入入口；fs 没有 create / update / archive / fork 等生命周期族（项
  目文件不是 aggregate，没有生命周期）。`mkdir` 与 query 共用 `IFsService`
  不构成 muddle（见下一条），不需要为它单独抽 `IFsCommandService`。
- **fs 的 runtime 是 `IFsWatcher`，不是 facade。** `FsWatcherService` 持有
  活的 `(connectionId → sessionId → WatchedSession)` map，管理 chokidar
  watcher、debounce / coalesce、按 connection 的 path 限额（
  `FsWatchLimitError`），经 `FsWatcherDeliverySink` 投递 `event.fs.changed`
  帧。它对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的“由进程内对象 / 事件流推导的活状态”的 owner，从不出现在 SDK 读模型
  里。
- **fs 的路径安全是基础设施，不是 service。** `resolveSafePath`（
  `fsPathSafety.ts:38`）是纯函数 + 错误类，被 `FsService` /
  `FsSearchService` 的每个方法调用，不持有状态、不是 `*Service` DI 单例。

### 3. fs 的 query 与 `mkdir` command 共用 `IFsService` 不构成 muddle

`list` / `read` / `stat` / `listMany` / `statMany` / `resolveDownload` /
`resolvePath`（query）与 `mkdir`（command）共用一个 `IFsService` 接口，但这
是同一个会话内文件操作 facade 上的独立方法：

- 实现互不调用：`FsService.list`（`fsService.ts:60`）/ `read`（`:163`）/
  `stat`（`:269`）/ `mkdir`（`:331`）各自经 `resolveSafePath` 取安全路径
  后直接操作 `node:fs`，互不调用对方的业务方法。
- 共享的只是“session → cwd → resolveSafePath → node:fs”这条管道：
  `this.sessions.get(sessionId)` + `resolveSafePath(cwd, req.path)`。这条管
  道是会话内文件操作的基础设施，不是 query 或 command 的业务逻辑。
- AGENTS.md 的 “command / query 角色不互相调用业务方法” 针对的是**实现耦
  合**，不是**接口同址**。`IFsService` 的方法满足这条规则。

真正的角色分离（query+command facade vs runtime watcher vs path-safety
helper）已经按文件物理分离，没有重叠或渗漏（见 DR6）。

### 4. fileStore 是全局 blob 持久化 domain，不是 fs 的“写那一半”

fileStore 与 fs 都“写文件到磁盘”，但二者本质不同：

- **键不同**：fs 用 `(sessionId, relPath)`（用户在项目树里指定的相对路
  径）；fileStore 用自己生成的 `fileId`（`f_<ulid>`，消费者对路径无感）。
- **作用域不同**：fs 受 `session.metadata.cwd` 约束；fileStore 全局，写在
  `<env.homeDir>/files/` 下，不知道任何 session。
- **真相不同**：fs 的真相是用户项目树（用户直接拥有、直接编辑）；fileStore
  的真相是上传 blob 库（agent / SDK 通过 `IFileStore` 间接拥有，用户按
  `fileId` 引用）。
- **生命周期不同**：fs 的“文件”跟随项目（用户 / git 管理）；fileStore 的
  blob 有 `expires_at`、可 `delete`，是上传附件 / 媒体的中转存储。

把 fileStore 并进 fs 会把“项目文件”与“上传 blob”混为一谈：fs 的 `mkdir`
是相对路径、cwd 内、用户可见；fileStore 的 `save` 是流式上传、全局、按
`fileId` 引用、有大小限额（`DEFAULT_MAX_UPLOAD_BYTES` = 50MB）和过期。二者
的写语义完全不同，不能共用 `write` / `save` 接口。

### 5. workspaceFs 是 workspace aggregate 的 browse / home 表面，不是 fs 的一种 scope

workspaceFs 与 fs 都“列目录”，但二者也本质不同：

- **路径语义相反**：fs **拒绝**绝对路径（`resolveSafePath` 对
  `path.isAbsolute(inputPath)` 抛 `FsPathEscapesError('absolute')`，
  `fsPathSafety.ts:47`）；workspaceFs **要求**绝对路径（`browse` 对非绝对
  路径抛 `WorkspaceFsNotAbsoluteError`，`workspaceFsService.ts:33`）。
- **作用域相反**：fs 必须 scoped 到 session cwd（无 session 即无 fs）；
  workspaceFs **故意不** scoped 到 session——它用于 session 创建**之前**浏
  览宿主磁盘、挑选 workspace root。
- **写能力相反**：fs 有 `mkdir`（写）；workspaceFs 是 query-only（browse /
  home 都是只读）。
- **归属不同**：fs 是独立 domain；workspaceFs 住在 `services/workspace/`，
  是 workspace aggregate 的读表面，已被 `IWorkspaceService` 统一 facade 吸
  收（`IWorkspaceService.browse` / `home` 委托 `IWorkspaceFsService`，
  `workspaceService.ts:60-66`）。

把 workspaceFs 并进 fs 会制造矛盾：同一个 service 既要“拒绝绝对路径、约束
在 cwd”又要“要求绝对路径、浏览宿主任意目录”。这两种语义不能共存于一个路
径模型。workspaceFs 属于 workspace domain（它返回的 `FsBrowseEntry` 带
`is_git_repo` / `branch`，是 workspace root 选择的视图），不属于 fs
domain。

### 6. 三者互不引用；向上各自由独立 transport 消费

fs / fileStore / workspaceFs 之间**没有任何 import**（`grep` 对三目录交叉
引用为空）。它们各自向上被独立的 transport 表面消费：

- fs → `packages/server/src/routes/fs.ts`（`IFsService` / `IFsSearchService`
  / `IFsGitService`，REST 路由）。
- fs runtime watcher → `packages/server/src/start.ts`（`IFsWatcher` /
  `FsWatcherService` / `createConnectionLookup`，连接级投递 wiring）。
- fileStore → `packages/server/src/routes/files.ts`（上传 / 下载 / 删除）+
  `packages/server/src/routes/prompts.ts`（`resolvePromptMediaFiles` 按
  `fileId` 解析媒体）。
- workspaceFs → `packages/server/src/routes/workspaceFs.ts`
  （`IWorkspaceFsService.browse` / `home`）。

这条“互不引用 + 各自独立 transport 表面”的边界是“是否需要拆分 / 合并”的
硬指标：只要三者不共享真相、不互相调用、不共享 transport，三类关注点就是
清晰的，不需要代码拆分。

## Service 拆分概览

| Service / 角色 | 一句话职责 | 角色 | Domain |
|---|---|---|---|
| `IFsService` | 会话内文件核心 facade：`list` / `read` / `stat` / `listMany` / `statMany` / `resolveDownload` / `resolvePath`（query）+ `mkdir`（command） | query + command（facade） | fs |
| `FsService` | `IFsService` 实现：session → cwd → `resolveSafePath` → `node:fs`，gitignore matcher 缓存，二进制 / mime / etag 推导 | query + command（impl） | fs |
| `IFsSearchService` / `FsSearchService` | 会话内文件名 / 内容搜索：`search` / `grep`（spawn 子进程 + gitignore） | query（impl） | fs |
| `IFsGitService` / `FsGitService` | 会话内 git 读模型：`status` / `diff`（porcelain / numstat 解析 + PR 缓存） | query（impl） | fs |
| `IFsWatcher` / `FsWatcherService` | fs 活订阅 runtime：connection-scoped watcher + debounce / coalesce + `event.fs.changed` 投递 + path 限额 | runtime（impl） | fs |
| `resolveSafePath` / `FsPathEscapesError`（`fsPathSafety.ts`） | 路径安全基础设施：拒绝空 / 绝对 / `..` / 越界 / symlink 越界 | infrastructure（非 service） | fs |
| `IFileStore` | 全局 blob 持久化 facade：`save` / `delete`（command）+ `get`（query） | query + command（repository contract） | fileStore |
| `FileStore` | `IFileStore` 实现：`<env.homeDir>/files/<fileId>` blob + `index.json` 元数据索引 + 大小限额 + 过期 | query + command（impl + 持久化） | fileStore |
| `IWorkspaceFsService` / `WorkspaceFsService` | workspace browse / home 读表面：`browse(absPath?)` / `home()`（绝对路径、非会话作用域） | query（impl） | workspace |
| `IWorkspaceService` / `WorkspaceService` | workspace 统一 facade：registry + root 解析 + recent + **browse / home**（委托 `IWorkspaceFsService`） | query + command（facade，workspace domain） | workspace |

> 只有这些角色。**不为 fs 引入统一的 `IFsQueryService` / 单独的
> `IFsCommandService`**——fs 的 query 已按职责（核心 / 搜索 / git）拆成三
> 个 service，`mkdir` 是唯一的写、与 query 共用 `IFsService` 不构成 muddle，
> 再拆一层只是同名复制 + 管道复制。**不为 fileStore 拆 command / query**
> ——`IFileStore` 只有 `save` / `delete` / `get` 三个方法，是 repository
> contract 的直接暴露，拆成两个接口不带来新契约。**不把 workspaceFs 从
> workspace 拆进 fs**——workspaceFs 的“绝对路径、非会话作用域、query-only”
> 语义与 fs 的“相对路径、cwd 内、可写”语义相反，它是 workspace aggregate
> 的读表面，已被 `IWorkspaceService` 吸收。
> 共享类型（`FsEntry` / `FsListRequest` / `FsReadResponse` / `FsGitStatus` /
> `FsChangeEntry` / `FileMeta` / `FsBrowseEntry` / `FsBrowseResponse` /
> `FsHomeResponse` 等）见 `@moonshot-ai/protocol`。

模式参考：

- query 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md)
  的**只读 list / get 语义**：fs 的 `IFsService` / `IFsSearchService` /
  `IFsGitService`、fileStore 的 `IFileStore.get`、workspaceFs 的
  `IWorkspaceFsService.browse` / `home` 都是只读读模型入口；但三者 scope
  各不同（单 session / 全局 fileId / 绝对路径）、无跨 scope 的统一分页 /
  search / count，所以**不套用**完整的 `BaseQuery` + scope 便捷方法骨架。
- command 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)
  的**唯一写入入口**语义：fs 的 `mkdir`、fileStore 的 `save` / `delete` 各
  自是其 domain 的写入入口；但 fs 没有 create / update / archive / fork 生命
  周期族（项目文件不是 aggregate），fileStore 是 blob 中转（无 lifecycle），
  所以**不套用**完整的 `ICommandService` 生命周期骨架。
- runtime 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的“由进程内对象 / 事件流推导的活状态”的 owner：`FsWatcherService` 持
  有 connection-scoped 的活 watcher，由 chokidar 事件推导 `event.fs.changed`
  帧向外投递；它不是 daemon / SDK 的 query / command facade。

## 统一的文件访问流

### fs：会话内 read（query）

```text
routes/fs.ts  read
  └─ IFsService.read(sessionId, req)
       ├─ ISessionService.get(sessionId)            // 取 session.metadata.cwd
       ├─ resolveSafePath(cwd, req.path)            // 约束在 cwd 内；拒绝绝对 / .. / 越界
       ├─ fs.stat(safe.absolute)                    // 大小 / 类型校验
       ├─ detectBinary(sample)                      // 二进制嗅探
       └─ readFileRange(...) → FsReadResponse        // content / encoding / etag / mime
```

要点：

- 每一次 fs 调用都重新 `sessionId → cwd → resolveSafePath`；cwd 是 session
  的真相，路径约束是 fs 的基础设施，二者都不缓存相对路径的语义。
- fs 不写真相（除 `mkdir`）；项目树由用户 / git 拥有，fs 只是受限的读写窗
  口。

### fs：会话内 mkdir（command，唯一写）

```text
routes/fs.ts  mkdir
  └─ IFsService.mkdir(sessionId, req)
       ├─ ISessionService.get(sessionId)
       ├─ resolveSafePath(cwd, req.path)
       └─ fs.mkdir(safe.absolute, { recursive })     // EEXIST → FsAlreadyExistsError
```

要点：

- `mkdir` 是 fs domain 对 daemon / SDK 的唯一写入。它与 query 共用
  `IFsService`，但实现独立（不调任何 query 方法），共享的只是 session →
  cwd → resolveSafePath 管道。

### fs：活订阅 watcher（runtime）

```text
server start
  └─ FsWatcherService + createConnectionLookup(getConnection)   // 连接级投递 wiring

订阅
  └─ IFsWatcher.addPaths(sessionId, connectionId, absPaths)
       ├─ 按 (connectionId, sessionId) 建 WatchedSession（chokidar）
       ├─ maxPathsPerConnection 闸门（FsWatchLimitError）
       └─ chokidar 'change'/'add'/'unlink' → debounce / coalesce
            └─ FsWatcherDeliverySink.send({ type: 'event.fs.changed', ... })

取消
  └─ IFsWatcher.removePaths(...) / forgetConnection(connectionId)
```

要点：

- `FsWatcherService` 是 fs domain 唯一的 runtime owner：活 watcher 由它持
  有，事件由它 debounce / coalesce，投递经注入的 `FsWatcherConnectionLookup`
  解析连接 sink。它不出现在 SDK 读模型里，query / command 也不调它。

### fileStore：上传 blob（command）+ 按 fileId 读取（query）

```text
routes/files.ts  upload
  └─ IFileStore.save(source, filename, options)
       ├─ ensureIndex()                              // 加载 <home>/files/index.json
       ├─ fileId = `f_${ulid()}`
       ├─ pipeline(source, createWriteStream(blobPath))  // 流式 + maxUploadBytes 闸门
       └─ indexCache.set(fileId, meta) + writeIndex()    // 原子 rename 写索引

routes/files.ts  download
  └─ IFileStore.get(fileId) → { meta, blobPath }
       └─ createReadStream(blobPath)                  // 消费者拿不到真实路径，只按 fileId

routes/prompts.ts  resolvePromptMediaFiles
  └─ IFileStore.get(fileId) → { meta, blobPath }      // 媒体按 fileId 解析进 prompt
```

要点：

- `FileStore` 是 fileStore domain 的唯一 owner：blob 落在
  `<env.homeDir>/files/<fileId>`，元数据在 `index.json`，写索引用 tmp +
  rename 保证原子性。
- fileStore 不知道 session / cwd / 项目树；消费者按 `fileId` 引用，拿不到也
  不需要真实路径。这是它与 fs “项目文件” 的根本区别。

### workspaceFs：绝对路径 browse + home（workspace query 表面）

```text
routes/workspaceFs.ts  browse
  └─ IWorkspaceFsService.browse(absPath?)
       ├─ target = absPath ?? os.homedir()
       ├─ isAbsolute(target) 校验（非绝对 → WorkspaceFsNotAbsoluteError）
       ├─ fsp.realpath(target) + fsp.readdir(dirOnly)
       └─ 每个子目录 detectGit(childAbs) → FsBrowseEntry{ is_git_repo, branch }

routes/workspaceFs.ts  home
  └─ IWorkspaceFsService.home()
       ├─ os.homedir()
       └─ IWorkspaceRegistry.list() → recent_roots（cap RECENT_ROOTS_LIMIT）
```

要点：

- workspaceFs 是 workspace aggregate 的读表面：它**要求**绝对路径、**不**
  scoped 到 session，用于 session 创建之前挑选 workspace root。
- 它已被 `IWorkspaceService` 统一 facade 吸收：`WorkspaceService.browse` /
  `home` 直接委托 `IWorkspaceFsService`（`workspaceService.ts:60-66`）。新代
  码应依赖 `IWorkspaceService`，遗留 `IWorkspaceFsService` 保留给现有消费
  者。

## 关键场景

### 场景 A：在 session 内读一个项目文件（fs query）

```ts
fsService.read(sid, { path: 'src/index.ts', encoding: 'utf-8', offset: 0, length: 65536 });
```

内部解析：`FsService.read`（`fsService.ts:163`）→
`this.sessions.get(sid)` 取 `metadata.cwd` → `resolveSafePath(cwd,
'src/index.ts')` 约束在 cwd 内 → `fs.stat` 校验大小 / 非目录 →
`detectBinary` 嗅探 → `readFileRange` → `FsReadResponse`（content / etag /
mime / language_id）。无写入、无 watcher、不碰 fileStore。

### 场景 B：在 session 内创建目录（fs command）

```ts
fsService.mkdir(sid, { path: 'src/new-dir', recursive: true });
```

内部解析：`FsService.mkdir`（`fsService.ts:331`）→ 同样的 session → cwd →
`resolveSafePath` 管道 → `fs.mkdir(safe.absolute, { recursive })`；`EEXIST`
映射为 `FsAlreadyExistsError`，`ENOENT`/`ENOTDIR` 映射为 `FsPathNotFoundError`。
这是 fs domain 唯一的写操作；实现不调用任何 query 方法。

### 场景 C：订阅 session 内某目录的文件变化（fs runtime）

```ts
fsWatcher.addPaths(sid, connId, ['/abs/proj/src']);
// …chokidar 事件… → connection 收到 { type: 'event.fs.changed', payload: { changes, ... } }
```

内部解析：`FsWatcherService.addPaths` 按 `(connId, sid)` 建 / 复用
`WatchedSession`（chokidar），受 `maxPathsPerConnection` 闸门；事件经
debounce / coalesce 后由注入的 `FsWatcherDeliverySink` 投递
`event.fs.changed` 帧。`forgetConnection(connId)` 在连接断开时清理。这是
runtime 角色，与 query / command 互不调业务方法。

### 场景 D：上传一个文件并拿回 fileId（fileStore command）

```ts
const meta = await fileStore.save(readableStream, 'avatar.png', { mimeType: 'image/png' });
// meta.id = 'f_01J…'；后续按 meta.id 引用
```

内部解析：`FileStore.save`（`fileStoreService.ts:46`）→ `ensureIndex` 加载
`<home>/files/index.json` → 生成 `f_<ulid>` → `pipeline(source,
createWriteStream(blobPath))` 流式写入，超 `DEFAULT_MAX_UPLOAD_BYTES` 抛
`FileTooLargeError` 并清理半成品 → `indexCache.set` + `writeIndex`（tmp +
rename 原子）。与 session / cwd 完全无关。

### 场景 E：按 fileId 读取 / 删除 blob（fileStore query / command）

```ts
const { meta, blobPath } = await fileStore.get('f_01J…');   // query
await fileStore.delete('f_01J…');                           // command
```

内部解析：`get`（`fileStoreService.ts:106`）从 `indexCache` 取 meta，校验
blob 存在（缺失则清理索引并抛 `FileNotFoundError`），返回 `{ meta,
blobPath }`；`delete`（`:128`）删索引 + `fsp.unlink(blobPath)` + `writeIndex`。
消费者按 `fileId` 引用，不直接操作路径。

### 场景 F：session 创建前浏览宿主磁盘挑选 workspace root（workspaceFs query）

```ts
const { path, parent, entries } = await workspaceFs.browse('/Users/me/projects');
// entries: FsBrowseEntry[]（dirOnly，每个带 is_git_repo / branch）
const { home, recent_roots } = await workspaceFs.home();
```

内部解析：`WorkspaceFsService.browse`（`workspaceFsService.ts:30`）校验
`isAbsolute` → `realpath` + `readdir(dirOnly)` → 每个子目录 `detectGit` →
`FsBrowseResponse`；`home`（`:76`）取 `os.homedir()` + `registry.list()` 派
生 `recent_roots`。这是 workspace aggregate 的读表面，**不** scoped 到
session，**要求**绝对路径——与 fs 的“相对路径、cwd 内”语义相反。新代码经
`IWorkspaceService.browse` / `home` 访问同一能力。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 | Domain |
|---|---|---|---|
| 列出 session 内目录 | `fsService.list(sid, req)` / `listMany` | query（facade） | fs |
| 读 session 内文件 | `fsService.read(sid, req)` | query（facade） | fs |
| stat session 内路径 | `fsService.stat(sid, req)` / `statMany` | query（facade） | fs |
| 解析下载元数据 | `fsService.resolveDownload(sid, relPath)` | query（facade） | fs |
| 解析相对路径 | `fsService.resolvePath(sid, relPath)` | query（facade） | fs |
| 创建 session 内目录 | `fsService.mkdir(sid, req)` | command（facade） | fs |
| 搜索文件名 / 内容 | `fsSearchService.search(sid, req)` / `grep` | query | fs |
| git 状态 / diff | `fsGitService.status(sid, req)` / `diff` | query | fs |
| 订阅文件变化 | `fsWatcher.addPaths(sid, connId, absPaths)` | runtime | fs |
| 取消订阅 | `fsWatcher.removePaths(...)` / `forgetConnection(connId)` | runtime | fs |
| 路径安全校验 | `resolveSafePath(cwd, relPath)`（`fsPathSafety.ts`） | infrastructure | fs |
| 上传文件 | `fileStore.save(source, filename, options)` | command | fileStore |
| 按 fileId 读 blob | `fileStore.get(fileId)` → `{ meta, blobPath }` | query | fileStore |
| 删除 blob | `fileStore.delete(fileId)` | command | fileStore |
| 浏览宿主目录 | `workspaceFsService.browse(absPath?)` / `IWorkspaceService.browse` | query | workspace |
| 取 home + 最近 root | `workspaceFsService.home()` / `IWorkspaceService.home` | query | workspace |
| REST 路由（fs） | `packages/server/src/routes/fs.ts` | transport | fs |
| REST 路由（fileStore） | `packages/server/src/routes/files.ts` + `routes/prompts.ts` | transport | fileStore |
| REST 路由（workspaceFs） | `packages/server/src/routes/workspaceFs.ts` | transport | workspace |
| watcher wiring | `packages/server/src/start.ts`（`IFsWatcher` + `createConnectionLookup`） | transport / runtime | fs |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service (daemon / SDK facade)
  IFsService                          (fs query + command — 会话内 list/read/stat/mkdir/resolve)
  IFsSearchService                    (fs query — 会话内 search/grep)
  IFsGitService                       (fs query — 会话内 git status/diff)
  IFileStore                          (fileStore query + command — 全局 blob save/get/delete)
  IWorkspaceService                   (workspace facade — registry + root + recent + browse/home)
  IWorkspaceFsService                 (workspace query — 绝对路径 browse/home，被 IWorkspaceService 吸收)

Runtime (in-process, connection-scoped)
  IFsWatcher / FsWatcherService       (fs runtime — chokidar 活订阅 + event.fs.changed 投递)

Infrastructure (not *Service)
  resolveSafePath / FsPathEscapesError (fs 路径安全 helper — cwd 内约束)
  detectGit                            (workspaceFs 的 git repo 嗅探 helper)

Persistence / Truth
  用户项目树 (session.metadata.cwd 下)  (fs 真相 — 用户 / git 拥有)
  <env.homeDir>/files/<fileId> + index.json (fileStore 真相 — blob + 元数据索引)
  IWorkspaceRegistry                   (workspace 真相 — 注册表；workspaceFs.home 的 recent_roots 来源)

Transport (above agent-core)
  packages/server/src/routes/fs.ts            (fs REST)
  packages/server/src/routes/files.ts         (fileStore REST)
  packages/server/src/routes/prompts.ts       (fileStore 媒体解析)
  packages/server/src/routes/workspaceFs.ts   (workspaceFs REST)
  packages/server/src/start.ts                (fs watcher wiring)
```

依赖关系：

```text
IFsService.*                 → ISessionService.get + resolveSafePath + node:fs   (query/command → session cwd + 路径安全)
IFsSearchService.*           → ISessionService.get + spawn + node:fs             (query → 子进程搜索)
IFsGitService.*              → ISessionService.get + git child_process           (query → git 解析)
IFsWatcher                   → chokidar + FsWatcherDeliverySink                  (runtime → 活订阅 + 投递)
IFileStore.save/get/delete   → IEnvironmentService.homeDir + node:fs + index.json (query/command → 全局 blob 持久化)
IWorkspaceFsService.browse   → node:fs + detectGit                               (query → 宿主磁盘，绝对路径)
IWorkspaceFsService.home     → os.homedir + IWorkspaceRegistry                   (query → 派生 recent_roots)
IWorkspaceService.browse/home → IWorkspaceFsService                              (facade 委托)
routes/fs.ts                 → IFsService / IFsSearchService / IFsGitService      (transport → fs)
routes/files.ts              → IFileStore                                        (transport → fileStore)
routes/prompts.ts            → IFileStore                                        (transport → fileStore 媒体)
routes/workspaceFs.ts        → IWorkspaceFsService                               (transport → workspaceFs)
start.ts                     → IFsWatcher / FsWatcherService / createConnectionLookup (transport → fs runtime wiring)
```

禁止的边界：

```text
services/fs/**          ⇄ services/fileStore/**          (fs 与 fileStore 互不引用)
services/fs/**          ⇄ services/workspace/**          (fs 与 workspaceFs 互不引用)
services/fileStore/**   ⇄ services/workspace/**          (fileStore 与 workspace 互不引用)
services/fileStore/**   → ISessionService / session cwd  (fileStore 不知道 session / cwd)
services/workspaceFs    → ISessionService / resolveSafePath (workspaceFs 不 scoped 到 session，不做 cwd 路径安全)
services/fs (query)     → IFsWatcher 业务方法            (query/command 不调 runtime 业务方法；watcher 独立 wiring)
IFsWatcher              → services/fs query/command      (runtime 不回调 facade)
IWorkspaceService       → (复制 browse/home 实现)        (facade 只委托，不复制 workspaceFs 逻辑)
```

关键不变量：

- fs / fileStore / workspaceFs 三目录之间**零 import**（`grep` 交叉引用为
  空）。三者共享的只是 `@moonshot-ai/protocol` 的协议类型与 `node:fs`，不共
  享任何 service / 状态 / 真相。
- fs 的真相是 `session.metadata.cwd` 下的项目树（用户 / git 拥有）；
  fileStore 的真相是 `<env.homeDir>/files/<fileId>` blob + `index.json`
  （fileStore 拥有）；workspaceFs 没有自己的真相（`home().recent_roots` 派
  生自 `IWorkspaceRegistry`）。三种真相不重叠。
- fs 的所有路径经 `resolveSafePath` 约束在 cwd 内（拒绝绝对路径）；
  workspaceFs 的所有路径必须是绝对路径（`WorkspaceFsNotAbsoluteError`）；
  fileStore 的消费者拿不到路径（只按 `fileId`）。三种路径语义互不兼容，不能
  合并进同一个路径模型。
- fs 的 query / command 不调用 `IFsWatcher` 的业务方法；watcher 是独立的
  runtime wiring（`start.ts`），经 `FsWatcherDeliverySink` 投递
  `event.fs.changed`。command 副作用（`mkdir` 写盘）与 runtime 副作用
  （watcher 投递事件）各在其位。
- `IWorkspaceService.browse` / `home` 是纯委托（`workspaceService.ts:60-66`），
  不复制 `WorkspaceFsService` 的浏览逻辑；workspace domain 的统一 facade 与
  workspaceFs 读表面不重复实现。

## 决策记录

- **DR1：“file / fs” 是两个独立 domain + workspace 的一个读表面，不是一个
  domain。** fs（会话内文件操作）、fileStore（全局 blob 持久化）、
  workspaceFs（workspace 的 browse / home）共享 “文件系统” 的直觉，但键
  （`sessionId+relPath` / `fileId` / `absPath`）、作用域（cwd 内 / 全局 /
  宿主绝对路径）、真相（项目树 / blob 库 / 派生自 registry）、写语义、对外
  入口都不同。它们不合并成一个 “file / fs domain”，也不互相调用。
- **DR2：fs 是会话内文件操作 domain，query + 单写 command + runtime
  watcher。** `IFsService`（list/read/stat/listMany/statMany/
  resolveDownload/resolvePath = query；mkdir = command）、`IFsSearchService`
  / `IFsGitService`（query）、`IFsWatcher`（runtime）共同组成 fs domain；
  `resolveSafePath` 是其路径安全基础设施。所有方法 scoped 到 session、经
  `resolveSafePath` 约束在 cwd 内。
- **DR3：fs 的 query 与 `mkdir` 共用 `IFsService` 不构成 muddle。** 它们是
  同一会话内文件操作 facade 上的独立方法，实现互不调用（`FsService.mkdir`
  不调任何 query 方法），共享的只是 session → cwd → `resolveSafePath` →
  `node:fs` 这条基础设施管道。AGENTS.md 的 “command / query 角色不互相调用
  业务方法” 针对实现耦合，不是接口同址。共用 facade 避免了为一个单方法写
  角色复制整份 session → cwd → 路径安全管道。真正的角色分离（query+command
  facade vs runtime watcher vs path-safety helper）已按文件物理分离。
- **DR4：fileStore 是全局 blob 持久化 domain，不是 fs 的“写那一半”。**
  `IFileStore.save` / `delete` / `get` 是 repository contract 的直接暴露：
  键是 `fileId`、作用域全局、真相是 blob + `index.json`、有大小限额与过
  期。它与 fs 的 `mkdir`（相对路径、cwd 内、用户可见的项目文件）写语义完
  全不同，不能共用 `write` / `save` 接口，也不能并入 fs。
- **DR5：workspaceFs 是 workspace aggregate 的 browse / home 读表面，不是
  fs 的一种 scope。** workspaceFs 要求绝对路径、不 scoped 到 session、
  query-only，用于 session 创建之前挑选 workspace root——这与 fs 的“相对
  路径、cwd 内、可写”语义相反，不能共存于一个路径模型。它住在
  `services/workspace/`，已被 `IWorkspaceService` 统一 facade 吸收
  （`browse` / `home` 委托 `IWorkspaceFsService`）。
- **DR6：三者互不引用 + 各自独立 transport 表面。** fs → `routes/fs.ts` +
  `start.ts`（watcher wiring）；fileStore → `routes/files.ts` +
  `routes/prompts.ts`；workspaceFs → `routes/workspaceFs.ts`。三目录之间零
  import。这条边界是“是否需要拆分 / 合并”的硬指标：不共享真相、不互相调
  用、不共享 transport，三类关注点就是清晰的。
- **DR7：不引入统一的 `IFsQueryService` / 单独的 `IFsCommandService`。**
  fs 的 query 已按职责（核心 IO / 子进程搜索 / git 解析）拆成三个 service，
  `mkdir` 是唯一写、与 query 共用 `IFsService` 不构成 muddle。再抽统一
  query 接口会把三种实现压进一个接口；为 `mkdir` 单抽 command 接口只是同名
  复制 + 管道复制。
- **DR8：不为 fileStore 拆 command / query。** `IFileStore` 只有 `save` /
  `delete` / `get` 三个方法，是 blob repository contract 的直接暴露。拆成
  `IFileStoreCommandService` / `IFileStoreQueryService` 不带来新契约，反而
  把一个三方法 facade 拆成两个需要同时注入的接口。
- **DR9：不把 workspaceFs 从 workspace 拆进 fs。** workspaceFs 的“绝对路径、
  非会话作用域、query-only、返回 `is_git_repo` 视图”语义属于 workspace
  aggregate（workspace root 选择的读模型），已被 `IWorkspaceService` 吸收。
  把它并进 fs 会制造“同一 service 既要拒绝绝对路径又要要求绝对路径”的矛
  盾。保留它在 `services/workspace/` 是正确的归属。
- **DR10：当前代码布局已满足边界，无需迁移。** fs domain 在
  `services/fs/`（`IFsService` / `FsService` query+command +
  `IFsSearchService` / `FsSearchService` query + `IFsGitService` /
  `FsGitService` query + `IFsWatcher` / `FsWatcherService` runtime +
  `resolveSafePath` infrastructure）；fileStore domain 在
  `services/fileStore/`（`IFileStore` / `FileStore` query+command + blob +
  `index.json` 持久化）；workspaceFs 在 `services/workspace/`
  （`IWorkspaceFsService` / `WorkspaceFsService` query，被
  `IWorkspaceService` / `WorkspaceService` 吸收）。三者经 `services/index.ts`
  注册为顶层 DI singleton，被 `packages/server` 的独立路由 / wiring 消费。
  依赖方向单向：transport（`packages/server`）→ services facade；services 之
  间无交叉引用；fs runtime watcher 独立 wiring。三层都没有反向 import，
  M0.1 fence 干净。本次只出概念定稿，不做代码拆分。
