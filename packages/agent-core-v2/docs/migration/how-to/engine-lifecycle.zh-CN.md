# 如何启动、使用、关闭 v2 引擎

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md) 的子文档;英文原版:[`engine-lifecycle.md`](engine-lifecycle.md)。

读者:在 v1 上 `new KimiCore(...)` / `new Session(...)` / `new Agent(...)`、现在需要在进程内驱动 v2 引擎的消费方。路径是:**bootstrap → accessor.get(服务)→ Program → session controller → 助手函数 → drain\* 关闭**。下文提到的 v2 符号大多经 `packages/agent-core-v2/src/index.ts` 再导出(bootstrap 系 :69-70,`mainAgent` :468,`sessionLookup` :501,`scopeContext` :738)。

## 1. bootstrap App scope(`packages/agent-core-v2/src/app/bootstrap/bootstrap.ts`)

**`BootstrapInput`**(:95-105):`homeDir?`、`configPath?`、`env?`、`osHomeDir?`、`platform?`、`arch?`、`cwd?`、`clientIdentity: KimiHostIdentity`(唯一必填)、`args?: HostArgsInput`。

**默认值**(`resolveBootstrapOptions` :107-123):

- `env` → `process.env`;`osHomeDir` → `os.homedir()`
- `homeDir` → `resolveKimiHome`(:163-169):`input.homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`
- `configPath` → `join(homeDir, 'config.toml')`(:111;另有独立助手 `resolveConfigPath` :171-176)
- `platform` → `process.platform`;`arch` → `process.arch`;`cwd` → `process.cwd()`
- `args` → `resolveHostArgs`(:36-45):仅 `requestHeaders` 默认 `{}`,其余字段(`agentFiles`/`skillDirs`/`displayName`/`replyStyleGuide`/`nonInteractive`)透传 undefined

**`HostArgsInput`/`HostArgs`**(:18-34):`agentFiles?`、`skillDirs?`、`requestHeaders`(解析后必填)、`displayName?`、`replyStyleGuide?`、`nonInteractive?`。

**`KimiHostIdentity`**(`packages/oauth/src/identity.ts:20-31`):`productName`、`version`、`platform`、`userAgentSuffix?`。

**`BootstrapResult`**(:134-136):`{ readonly app: Scope }`。`Scope` 满足 `IScopeHandle`(`_base/di/scope.ts:111-116`:`id`/`kind`/`accessor`/`dispose()`);`createAppScope` 在 `_base/di/scope.ts:298-300`。

**`bootstrap(input, extraSeeds = [])`**(:138-144):`createAppScope({ seeds: [...bootstrapSeed(input), ...storageSeed(options), ...skillSeed(), ...extraSeeds] })`。内建三份 seed:

- `bootstrapSeed`(:125-132):`IBootstrapOptions` 值
- `storageSeed`(:146-152):`IFileSystemStorageService` → `SyncDescriptor(FileStorageService, [homeDir, 0o700, 0o600])`
- `skillSeed`(:154-161):`ISkillDiscovery` → `SyncDescriptor(FileSkillDiscovery, [])`

**extraSeeds 机制**:`ScopeSeed = ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>`(`_base/di/scope.ts:101-103`);`buildCollection`(:122-130)按序 `collection.set(id, value)`——**后写的覆盖先写的**,extraSeeds 拼在最后,因此消费方可覆盖内建 seed(测试桩、log seed 都靠这个)。实际用例:node-sdk 传 `[...logSeed(resolveLoggingConfig(...))]`(`packages/node-sdk/src/sdk-rpc-client-v2.ts:466`);kap-server 传 `[...logSeed(logging), ...(opts.seeds ?? [])]`(`packages/kap-server/src/start.ts:196-210`);测试传 `[[ISessionIndex, stub], [IGitService, stub]]`(`packages/kap-server/test/v2Sessions.test.ts:181-184`)。`logSeed`/`resolveLoggingConfig` 定义于 `packages/agent-core-v2/src/_base/log/logConfig.ts:41,54`。

辅助函数:`ensureKimiHome(homeDir)`(:178-180,`mkdirSync` recursive 0o700)。

**`BootstrapService`**(`bootstrapService.ts:14-69`):App scope、`ScopeActivation.OnScopeCreated` 注册(:71)。派生目录:`sessionsDir/blobsDir/storeDir/cacheDir/logsDir = join(homeDir, ...)`(:45-49);`configKey = basename(configPath)`(:50);`scope(name: PersistenceScopeName)`(:66-68,`PersistenceScopeName` 见 bootstrap.ts:62-69:'config'|'sessions'|'blobs'|'store'|'logs'|'cache'|'credentials');`getEnv(name)`(:62-64)。

## 2. 从 accessor 取服务

bootstrap 之后一切经 `app.accessor.get(IXxxService)`:`IConfigService`、`ISessionIndex`、`IWorkspaceInstanceManager`、`ISessionManager`、`IPluginService`、`IEventService` 等。ondemand 服务在首次 `get` 时物化;eager 服务已经就绪。注意就绪纪律:许多服务暴露 `ready` promise——config/model/provider 的读要等初始 load 落定后才同步可用(见 §7 的 `configReady`/`modelReady` 模式)。

## 3. Program:每 workspace 一个(`packages/agent-core-v2/src/program/program.ts`)

`class Program`(:113-388)。**构造**(:126-140):`new Program(workspaceId, runtimes: RuntimeRegistry, context: IWorkspaceContext, dependencies: ProgramDependencies)`;立即冻结 `binding = { workspaceId, runtimeId: 'local' }`(:132)、订阅 `runtimes.onDidChange` 并 `reconcileGeneration()`(同步建第一代)。

**公开成员**:

- `binding: RuntimeBinding`(:114)
- `onDidChange: Event<ProgramSnapshot>`(:116-117)
- `ready: Promise<void>`(:123-124;成功**或失败降级**都会 resolve——见 `resolveProgramReady` :375-378 及 :267-270/:353-358,即 ready 不意味着 healthy,需看 `status`)
- `status: ProgramStatus`(:142;'preparing'|'ready'|'degraded',:47)
- 服务 getter(无 generation 时抛 `program <id> has no available local runtime generation`,:239-242):`state/dirs/fs/watch/git/instructions/mcpConfig/mcp/trust/skills/agentProfiles`(:143-153)、`sessionControllerGeneration`(:154)
- `createSessionController(): SessionLifecycleService`(:156-185):generation 引用计数 +1,经 `dependencies.createSessionController(ProgramSessionControllerInput)` 创建;controller dispose 时回调 `release`(:160-164, :179)
- `snapshot(): ProgramSnapshot`(:187-227;`ProgramSnapshot` 形状 :74-84,含 `status/ready/generation/trusted/catalog/sources/runtimes`)
- `dispose()`(:229-237)

**generation 机制**:`PROGRAM_CAPABILITIES = ['fs','process','watch']`(:111);`createGeneration`(:276-336)`resolver.acquire(binding, PROGRAM_CAPABILITIES)` 取 `RuntimeLease`,逐个 new workspace 服务并入 `disposables`,构造失败逆序 dispose + lease.dispose(:331-335);runtime registry 变更触发 `reconcileGeneration`(:249-274),generation 以 `runtime.identity.generation` 标识,退役走引用计数(`retireGeneration`/`releaseGeneration` :362-373,`references` 初值 1,controller 各 +1,0 且 retired 时逆序 dispose)。`observeReadiness`(:338-360)等 `dirs/instructions/mcpConfig/mcp/skills/agentProfiles` 六个 ready。

**`ProgramDependencies`**(`programDependencies.ts:45-62`):`appState/bootstrap/config/git: LiveRef/identity/log/oauth: McpOAuthService/configStore/plugins/sessionManager: LiveRef/agentProfiles/builtinAgentProfiles/builtinSkills/telemetry/docs` + `createSessionController(input: ProgramSessionControllerInput): SessionLifecycleService`;`ProgramSessionControllerInput` :30-43。

**持有关系**:`WorkspaceInstance`(`workspace/workspaceInstance/workspaceInstance.ts:17-64`)组合 `runtimes/unitHost/program`(:32),其 `dispose()`(:56-63)顺序:program.dispose → unitHost.dispose → runtimes.dispose。`IWorkspaceInstanceManager`(`workspaceInstanceManager.ts:19-30`):`getOrCreate(ref)/get/findByRoot/findContaining/list/snapshot/close/addProvider`;App-scope OnScopeCreated 注册(`workspaceInstanceManagerService.ts:312`),构造时默认注册 `'local'` provider(:81)。

不要自行 `new Program`——经 `IWorkspaceInstanceManager.getOrCreate(...).program` 或 §5 的助手 `programForSession` 取得。

## 4. 会话创建/恢复/关闭 API

**App 级门面 `ISessionManager`**(`app/sessionManager/sessionManager.ts:28-52`):`create/resume/get/status/whenResumeSettled/withLifecycleSerialization/list/close/archive/restore/delete/fork/createChild`,事件均可选(`onWillCreateSession` 等 6 个,`Event<...>` 后带 `?`)。实现 `SessionManager`(`sessionManagerService.ts:36-281`,App-scope OnScopeCreated 注册 :281):

- `create`(:63-72):`workspaces.getOrCreate` → `controllerForWorkspace`;`resume`(:74-86):`pendingResumes` 去重 + `serializeLifecycle` 每会话串行链(:103-115)
- `controllerForWorkspace`(:225-261)经 `program.sessionControllerGeneration` 校验代际、缓存复用或 `program.createSessionController()` 新建,并把 controller 的 6 个事件桥接为门面事件、维护 `sessions`/`owners` 映射;controller 空闲(sessionCount=0)即 dispose(:263-269)
- `controllerForSession`(:271-278):live→owner;冷→`ISessionIndex.get` → `workspaces.getOrCreate({workspaceId, root: summary.cwd})`
- `fork`/`createChild` 用排序多键串行(:176-206);`delete` 未找到抛 `Error2(SESSION_NOT_FOUND)`(:166-174)

**workspace 级 `ISessionLifecycleService`**(`workspace/sessionLifecycle/sessionLifecycle.ts:72-91`):事件 6 个(`onDidCreateSession`/`onWillCloseSession` 带 `IWaitUntil`;`SessionWillCreateEvent` 带 `readSeed/contributeSeed/onSessionDispose` :65-70)+ `create/get/list/resume/close/archive/restore/delete/fork/createChild`。选项类型:`CreateSessionOptions`(:12-18:`sessionId?/workDir/additionalDirs?/mainAgentBinding?/mcpServers?`)、`ResumeSessionOptions`(:28-31)、`ForkSessionOptions`(:20-26)、`CreateChildSessionOptions`(:33-38);`SessionCreateSource='startup'|'resume'|'fork'`(:8)、`SessionCloseReason='exit'|'archive'`(:10)。

实现 `SessionLifecycleService`(`sessionLifecycleService.ts:133-881`,由 `Program.createSessionController` 按 workspace generation 创建)关键行为:

- `create`(:205-239):id 缺省 `session_${randomUUID()}`(:896-898);先 `workspaceSkillCatalog.reloadSources(['user','explicit','extra',PLUGIN_SKILL_SOURCE_ID])`(:126-131, :207-209,best-effort);`materializeSession` 后按 `mainAgentBinding` 建主 agent、按 `DEFAULT_PLAN_MODE_SECTION` 进 plan 模式(:211-227);`appendSessionIndexEntry` 写 `session_index.jsonl` 并 flush(:323-331);失败回滚:删 map、drainAgents、handle.dispose、`hostFs.remove(sessionDir)`(:229-236)
- `materializeSession`(:241-321):等 `config/models/providers.ready` + `workspaceDirs.ready`(:246-247);`mergeAdditionalDirs`;`createScopedChildHandle(LifecycleScope.Session, sessionId, { seeds, configureContainer })`,seeds 含 `sessionContextSeed/ITelemetryService/sessionAgentProfileCatalogSeed/ISessionSkillCatalogData/ISessionInstructionsProvider/ISessionMcpHandle/ISessionWorkspaceInfo/sessionEphemeralMcpServersSeed`(:268-281);`onWillCreateSession` 在 `configureContainer` 内触发,监听方可 `contributeSeed`/`onSessionDispose`(:287-296);之后等 `ISessionMetadata.ready`、`ISessionToolPolicy.ready` 与全部 profile loader ready(:305-313)
- `resume`(:346-365)/`doResume`(:373-402):`resuming` map 去重(in-flight 时 `get()` 返回 undefined,:341-344);校验 `ISessionIndex` summary 存在且 `workspaceId` 匹配,否则返回 undefined;materialize 后主 agent 缺失则补建(:391-394);`announceCreated source:'resume'` 且 telemetry `session_load_failed` 记 `resumeFailures`,供 `whenResumeSettled`(:367-371)重抛
- `close`(:412-425)、`archive`(:427-447)、`restore`(:449-457,resume+`setArchived(false)`)、`delete`(:459-478:等在途 resume→不在本 workspace 且无 live 抛 `SESSION_NOT_FOUND`→有 live 先 close→`hostFs.remove(sessionDir)`→`index.remove`→`dropFileHistorySession`→journal `{deleted:true}`+flush)、`fork`(:491-679,含 turn 运行拒绝 `SESSION_FORK_ACTIVE_TURN`、quiescence hold、turnIndex 截断)、`createChild`(:681-696,=fork+父会话元数据)

## 5. 消费方助手函数

全部在 `packages/agent-core-v2/src/app/sessionManager/sessionLookup.ts`(签名为 `(accessor: ServicesAccessor, ...)`):

- `programForSession(accessor, sessionId): Promise<Program | undefined>`(:13-30):live 会话经 `ISessionContext.workspaceId` → `IWorkspaceInstanceManager.get(workspaceId)?.program`;冷会话经 `ISessionIndex.get` → `getOrCreate({workspaceId, root: summary.cwd})` → `.program`
- `resumeSessionById(accessor, sessionId, opts?): Promise<ISessionScopeHandle | undefined>`(:32-48):`ISessionManager.resume`,失败时 telemetry `track2('session_load_failed', {reason})` 后重抛
- `getLiveSessionById(accessor, sessionId): ISessionScopeHandle | undefined`(:50-55):`ISessionManager.get`
- `closeSessionById(accessor, sessionId): Promise<void>`(:57-62):`ISessionManager.close`
- `followSessionLifecycles(accessor, follow): IDisposable`(:68-77):`ISessionManager` 的 `onDidCloseSession`/`onDidArchiveSession` 可选,缺任一返回空 disposable;否则 `follow(manager as SessionLifecycleEvents)`
- `ensureMainAgent(session: ISessionScopeHandle, opts?): Promise<AgentContext>`(`session/agentLifecycle/mainAgent.ts:6-14`):`session.accessor.get(IAgentLifecycleService).create({...opts, agentId: MAIN_AGENT_ID})`(create-or-get)。**同名异符号注意**:`packages/kap-server/src/transport/mainAgent.ts:11` 另有 `ensureMainAgent(session): Promise<IAgentScopeHandle>`(kap-server 本地变体,返回 handle 而非 AgentContext)
- `agentContextOf(handle: IAgentScopeHandle): AgentContext`(`agent/scopeContext/scopeContext.ts:49-51`):`handle.accessor.get(IAgentScopeContext).agentContext`;相关 `agentContextOfScope`(:45-47)、`tryAgentContextOf`(:53-55)

## 6. 关闭路径 drain\* 与顺序约束

drain 函数(均为模块级、等待模块级 pending promise 集合;前两个与最后一个循环到集合清空):

- `drainAppendLogRetirements()`(`persistence/backends/node-fs/appendLogStore.ts:19-23`):等 append-log 退役/切换落盘;实例方法 `AppendLogStore.drainRetirements()`(:150-152)即委托它(接口声明 `persistence/interface/appendLogStore.ts:51`)
- `drainSessionMetadataWrites()`(`session/sessionMetadata/sessionMetadataService.ts:27-29`):等 session `state.json` 异步写
- `drainLogCloses()`(`_base/log/logService.ts:30-34`,登记入口 `trackLogClose` :21-28):等文件 log writer 关闭
- `drainSessionIndexMirror()`(`app/sessionIndex/sessionIndexMirrorService.ts:29-31`):等 mirror dispose 触发的排水;与之配套的**实例方法** `ISessionIndexMirror.drain()` 是把队列刷进 query store(服务 :33-59 起,dispose 时自动挂入 pendingDrains)
- `drainQueryStoreDisposals()`(`persistence/backends/minidb/miniDbQueryStore.ts:47-49`):等 MiniDB ClusterDb 异步 close
- `drainGlobalSearchDisposals()`(`packages/kap-server/src/search/searchService.ts:94-98`):kap-server 专有,等全局搜索库/worker 关闭

**单会话 close 顺序**(`SessionLifecycleService.close` sessionLifecycleService.ts:412-425):`announceWillClose`(`onWillCloseSession` IWaitUntil 火并等待)→ 从 map 删除 → `drainAgents`(逐个 `agentLifecycle.remove`,:484-489)→ `appendLogStore.drainRetirements()` → `drainSessionMetadataWrites()` → `indexMirror.drain()` → `handle.dispose()` → `drainLogCloses()` → 火 `onDidCloseSession` → telemetry `session_ended`。`archive`(:427-447)顺序不同:先 `setArchived(true)` → drainAgents → `drainRetirements` → publish `SessionArchived` → announceWillClose → …(同上尾部)。

**整引擎关闭(node-sdk)** `SDKRpcClientV2.close()`(`packages/node-sdk/src/sdk-rpc-client-v2.ts:510-535`):sessionWirings 全 dispose → appSubscriptions dispose → `klient.close()` → `ISessionIndexMirror.drain()`(**在 query store 还活着时**,注释 :519-522)→ `IMcpOAuthService.shutdown()`(须在 `app.dispose()` 前,:524-528)→ 取出 `IAppendLogStore` 引用 → `app.dispose()` → `appendLogStore.drainRetirements()` → `drainSessionIndexMirror()` → `drainQueryStoreDisposals()` → `drainLogCloses()`。

**整引擎关闭(kap-server)** `close`(`packages/kap-server/src/start.ts:293-327`):`configChangedPublisher.close()` → `app.close()`(Fastify;onClose 钩子在 :534-538 关 connectionRegistry/wssV1/broadcaster)→ 各订阅 dispose → `shutdownServerTelemetry`(:302)→ `drainSessionMetadataWrites()` → `ISessionIndexMirror.drain()` → `IMcpOAuthService.shutdown()` → `fsWatchBridge.dispose()` → 取 `IAppendLogStore` → `core.dispose()` → `appendLogStore.drainRetirements()` → `drainSessionIndexMirror()` → `drainGlobalSearchDisposals()` → `drainQueryStoreDisposals()` → `drainSessionMetadataWrites()` → `drainLogCloses()`;finally 释放 instance registration、摘 process 处理器。两处共同约束:**mirror drain 必须先于 scope dispose;drain\* 必须在 scope dispose 之后调用(accessor 在 dispose 后抛错,故先取出服务引用);测试删 homeDir 前必须等 drain,否则 rm 竞态 ENOTEMPTY**(sdk-rpc-client-v2.test.ts:79-87 注释及 kap-server close 注释 :519-522)。

## 7. 测试如何起引擎

`packages/agent-core-v2/src/runtime/` 三件套:

- **`LocalRuntime`**(`runtime/localRuntime.ts:17-87`):真实本机 runtime,identity `{workspaceId, runtimeId:'local', generation:'local-<n>'}`(:39),能力集由传入的 host 服务是否存在决定(:40-45),初始 status `'ready'`;`LocalRuntimeProviderFactory`(:89-114)是默认 provider,`WorkspaceInstanceManager` 构造时注册(`workspaceInstanceManagerService.ts:81`)。
- **`StandaloneRuntimeFactory`**(`runtime/standaloneRuntime.ts:21-35`,App-scope OnDemand :37-43):`IStandaloneRuntimeFactory.createLocalRuntime(workspaceId)` 用 App 级 host 服务现场 new 一个 `LocalRuntime`(不经 registry/provider 体系)。
- **`FakeRuntime`**(`runtime/fakeRuntime.ts:8-79`):fs/process/watch/terminal 全 undefined,能力/状态/pathClass/环境均可构造参数注入,`setStatus()` 可驱动状态机——纯单测用(如 `test/app/sessionManager/sessionManagerService.test.ts:9` 配合手写 `SessionLifecycleService` 桩 :21-52)。

各包实测用法:

- **agent-core-v2 自身**:单测不走 `bootstrap`——用 `TestInstantiationService`+手写桩(`test/app/gateway/gateway.test.ts:8,31-42`)或 agent-scope 测试 harness `createTestAgent`/`testAgent`(`test/harness/agent.ts`,导出见 `test/harness/index.ts:1-37`,按 service group 覆写)。
- **klient**:真实引擎。`test/helpers/engine.ts:27-33` `makeEngine()` = mkdtemp home + `bootstrap({homeDir, clientIdentity: TEST_CLIENT_IDENTITY}, [...logSeed(resolveLoggingConfig(...))])`(文件头注释 :1-7 说明为什么必须带 logSeed);memory 传输 `createKlient({ scope: app })`,清理 `klient.close() → app.dispose() → rm homeDir`(`test/memory.test.ts:11-23`)。
- **kap-server**:真实 `startServer`(内部 bootstrap)。两种:(a) 全 suite 共享——vitest `globalSetup`(`test/globalSetup.ts:15-36`)起固定 token、seeds 注入 `IModelCatalog` fake,并关掉 `search_worker`/`persistence_minidb_readmodel` 两个 flag(:16-17);(b) 单文件自起——`test/v2Sessions.test.ts:174-187`,`seeds: [[ISessionIndex, stub], [IGitService, gitStub]]`。
- **node-sdk**:`createKimiHarnessV2({ homeDir, identity })`(内部 new `SDKRpcClientV2`)跑在 mkdtemp home 上(`test/sdk-rpc-client-v2.test.ts:99-103`);afterEach 先 `drainSessionIndexMirror()` + `drainQueryStoreDisposals()` 再 rm(:79-87)。

## 8. 实例:node-sdk `sdk-rpc-client-v2.ts` 调用顺序(关键行号)

`packages/node-sdk/src/sdk-rpc-client-v2.ts`(共 2817 行;v2 引擎 import 块 :159-246,`createKlient` :248):

**构造**(:432-497):`resolveKimiHome`(:436)→ `resolveConfigPath`(:437-440)→ `ensureKimiHome`(:441)→ `KimiAuthFacade`(:443-448)→ `assertKimiHostIdentity`(:450)→ **`bootstrap({homeDir, configPath, clientIdentity, args:{requestHeaders, skillDirs}}, [...logSeed(resolveLoggingConfig(...))])`**(:451-467)→ `this.app = app`(:468)→ **`createKlient({ scope: app })`(memory 传输**, :469)→ `configReady = IConfigService.ready`(:470)→ `installEngineTelemetry`(:471)→ `modelReady = configReady + IModelService.ready + IProviderService.ready`(:472-476)→ 两个 App 级订阅(:477-496):`IEventService.subscribe` 经 `translateGlobalEvent` 转 `receiveEvent`(:483-486)、`followSessionLifecycles(... onDidCloseSession → unwireSession)`(:491-495)。

**建会话**:`createSession`(:1320-1328,显式 id 走 `runSessionAccess` 串行队列 :943-957)→ `doCreateSession`(:1330-1370):live/index 双重查重(:1332-1342)→ `ISessionManager.create({sessionId, workDir, additionalDirs})`(:1343-1347)→ **`wireSession(handle)`**(:1350)→ 可选 `materializeMainAgent` + 设权限(:1351-1363)→ `klient.session(id).update` 写 metadata(:1364-1366)→ `liveSessionSummary`(:1369)。

**恢复**:`resumeSession`(:1489-1507):队列内 `resumeSessionById(engineAccessor, id, {additionalDirs})`(:1497)→ `wireSession`(:1501)→ `resumedSessionSummary`(:1502-1505,主 agent 经 `materializeMainAgent` :1102,子 agent 经 `IAgentLifecycleService.create` 冷恢复 :1119-1134)。`reloadSession`(:1517-1551):忙检查 → `config.reload`+`plugins.reload` → `closeSessionById`(:1542)→ `resumeSessionById`(:1544)→ wireSession。`forkSession`(:1419-1442):`runSessionAccessAll` 排序多键 → `programForSession`(:1427)→ `ISessionManager.fork`(:1429-1435)→ `resumeSessionById`(:1436)→ wireSession。

**事件接线**:`wireSession`(:1039-1042)= `new SessionEventWiring(handle, this)`,幂等;`unwireSession`(:1044-1052)由构造期的 close 订阅驱动,不另设调用点。`SessionEventWiring`(`packages/node-sdk/src/v2/session-wiring.ts:106-312`,头部设计说明 :1-24):订阅所有现存 agent 的 `IEventBus` + `onDidCreate` 覆盖后来出现的 subagent(:117 起),`translateDomainEvent` 回译 v1 `Event` 形状推给 `receiveEvent`;交互桥监听 `onSessionInteractionDidChangePending`,把 pending approval/question/user-tool 喂给 sink 回调并经 `ISessionApprovalService.decide`/`ISessionQuestionService.answer`/`respond` 写回。文件头注释(sdk-rpc-client-v2.ts:109-116)说明刻意绕过 klient events hub(其契约只含 13 种 bus 类型)。

**主 agent 物化**:`materializeMainAgent`(:1674-1704):`modelReady` → `ensureMainAgent(session)` → `handleOf` → 未绑定时 `IAgentProfileService.bind({profile: DEFAULT_AGENT_PROFILE_NAME, model, thinking})`,binding 缺省且 `MODEL_NOT_CONFIGURED` 时容忍未绑定(:1692-1701)。

**关闭**:`closeSession`(:1444-1448)= 队列内 `klient.session(id).close()`;整引擎 `close()`(:510-535)顺序见 §6。

## 待核 / 文档漂移

- **「`IWorkspaceLifecycleService.handlerFor`」在当前源码不存在**:工作区根 `AGENTS.md`(:22)与 node-sdk 注释(`sdk-rpc-client-v2.ts:36, 917-919`)均提到它,但 `grep` 在 `packages/agent-core-v2/src` 无任何匹配。当前真实链路是 `IWorkspaceInstanceManager.getOrCreate` → `WorkspaceInstance.program` → `Program.createSessionController()` → `SessionLifecycleService`;且 App 级门面 `ISessionManager` 已存在(与 AGENTS.md "there is no App-level session lifecycle facade" 一句矛盾)。迁移文档若引用旧名需按现状改写。
- `kap-server/src/transport/mainAgent.ts` 的 `ensureMainAgent` 与 agent-core-v2 导出的同名函数签名/返回类型不同(见 §5),撰写时勿混用。
- klient 的 `createKlient` 选项对象除 `{ scope }` 外是否还有其他字段(如 ipc 变体参数),未核 `packages/klient/src/transports/memory/index.ts` 签名——若 how-to 需要给出 klient 创建全参数,需补查。
