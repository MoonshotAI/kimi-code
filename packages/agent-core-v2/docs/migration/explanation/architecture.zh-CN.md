# 给 v1 读者的 v2 架构解说

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md)(下称「主文档」)的子文档;英文原版:[`architecture.md`](architecture.md)。

本文不教你怎么迁移——那是主文档的事。本文用 v1 读者已知的概念解释 v2 **为什么**长成这样:v1 的 DI 与 services 层如何工作、v2 在其上加了什么、scope 与单元如何生灭、Feature 缝是什么、哪些历史决策塑造了今天的形态。

## 1. v1 的 DI 与 services 层如何工作

### 1.1 DI 容器(`packages/agent-core/src/di/`)

v1 的 DI 是 VSCode `vs/platform/instantiation` 的零依赖移植,约 600 LoC,自有权威文档 `packages/agent-core/src/di/README.md`(319 行,含完整 bootstrap 示例与全部语义)。部件:

- `createDecorator<T>(name)`(`di/instantiation.ts:65`)铸造 branded callable `ServiceIdentifier<T>`(同名单例);兼作构造参数装饰器;接口必须声明 `readonly _serviceBrand: undefined`。
- `SyncDescriptor<T>`(`di/descriptors.ts:12`)包装 ctor + 静态参数 + `supportsDelayedInstantiation` 标志。
- `ServiceCollection`(`di/serviceCollection.ts:11`)是每容器 id → (descriptor | instance) 映射。
- `InstantiationService`(`di/instantiationService.ts:108`)是运行时容器:`invokeFunction(accessor)`(:143)、`createInstance`(:187)、`createChild(services)`(:200)、幂等 `dispose()`(:213)。
- `registerSingleton` / `getSingletonServiceDescriptors`(`di/extensions.ts:46` / `:87`):模块级全局注册表(数组 append,重复 id 不抛错、后注册者生效);bootstrap 用 `getSingletonServiceDescriptors()` 播种根容器。
- `InstantiationType`(`di/extensions.ts:23`):`Eager = 0` / `Delayed = 1`;Delayed → 容器返回 `Proxy`,首次非事件属性访问才运行真 ctor;`onDid*` 早订阅被 park、物化后重绑。
- 循环检测双机制(`di/graph.ts:11` / `di/errors.ts:30`):构造前 Graph walk(leaves-first)+ 根容器 `_inProgress` 构造栈兜底(ctor 体重入边)。
- `Disposable` / `IDisposable`(`di/lifecycle.ts`):销毁契约;`dispose()` 幂等,子容器先销毁,本容器实例按构造逆序(LIFO),Proxy 惰性实例走 `_servicesToMaybeDispose` 第二遍。
- `TestInstantiationService`(`di/testInstantiationService.ts:25`)仅经 subpath `@moonshot-ai/agent-core/di/test` 导出,提供 `.get` / `.set` / `.stub`。

注入惯用法:构造参数 `@IFoo` 装饰器自动注入(静态参数在前、服务参数在后,`GetLeadingNonServiceArgs` 推导前缀);`@IInstantiationService` 注入所属容器本身(子容器内解析到子容器)。

### 1.2 services 层(`packages/agent-core/src/services/`)

权威规范:`packages/agent-core/src/services/AGENTS.md`(190 行,normative)。事实要点:

- **定位**:agent-core 的"upper facade"层——可向下依赖 runtime(`rpc/`、`session/`、`agent/`、`di/`),runtime 不得反向 import `services/`(AGENTS.md:8-13)。由此前一个独立的 services 包并入。
- **命名约定**:统一 `Service` 后缀(禁 Bus/Broker/Bridge/Registry/Manager);decorator 字符串 = 接口名去 `I` 的 lowerCamelCase,出现在 `CyclicDependencyError.path` 与 "No service registered" 报错中(AGENTS.md:20-27)。
- **文件约定**:一域一 camelCase 目录;契约文件 `<domain>.ts`(接口 + decorator + sentinel errors),实现文件 `<domain>Service.ts`(底部 `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)` 自注册)(AGENTS.md:40-58, 125-141)。
- **facade 四种角色**(经 docstring 与接口形状表达,AGENTS.md:33-38):业务 facade(`Promise<T>` 为主,如 `IPromptService.submit`)/ 一次性反向 RPC broker(`request`+`resolve`,如 `IApprovalService`)/ pub-sub bus(`publish`+`onDidXxx`,如 `IEventService`)/ 跨进程 RPC adapter(`rpc`+`ready()`,如 `ICoreProcessService`)。
- **域清单**:22 个域目录(approval、auth、authSummary、config、coreProcess、environment、event、fileStore、fs、logger、mcp、message、modelCatalog、oauth、prompt、question、session、skill、task、terminal、tool、workspace)。
- **bootstrap 消费方式**:server 从 `getSingletonServiceDescriptors()` 播种;需要运行时参数/外部闭包时才 `services.set(I, new SyncDescriptor(C, [args], false))` 覆盖。
- **v1 引擎形态**:`KimiCore` / `Session`(`src/session/index.ts:230`)/ `Agent`(`src/agent/index.ts:115`)类体系 + 该 DI 服务层;`CoreProcessService`(`services/coreProcess/coreProcess.ts:57`)= 持有 `rpc: CoreRPC` mega-proxy 的跨进程 adapter(内部 `createRPC<CoreAPI, SDKAPI>()` 对 + `new KimiCore(coreRpc)`)。

要带往 v2 的心智模型:v1 只有**一棵**容器树(根 + 临时 createChild),注册表是**模块级静态**的、bootstrap 时一次性播种,services 的生命周期等于进程。v2 增加的一切,都是为了让注册带上*作用域*与*生命周期*。

## 2. v2 `_base/di/` 在 v1 之上增加了什么

v1 `di/` 被直接移植(同名文件:instantiation/instantiationService/descriptors/serviceCollection/extensions/graph/lifecycle/errors/test*),v2 新增 6+1 个文件。容器主体 `InstantiationService`(`_base/di/instantiationService.ts:121`)在构造时自建 `CascadeTree`(根容器)+ `CascadeEngine`(:177-219),子容器共享父的 tree 与 `CollectionStore`(:177-180)。

| 文件 | 一句话职责 | 关键类型 |
|---|---|---|
| `scope.ts` | 声明式作用域拓扑 + 按 scope 的静态服务注册表 + `Scope` 树(父子派生、拓扑校验、Ledger 级联销毁) | `ScopeKind`(:13)、`setScopeTopology`(:17,重复声明不同拓扑抛 `BugIndicatingError`)、`registerScopedService`/`overrideScopedService`(:47/:70,重复注册抛错)、`ScopeActivation`(来自 instantiation.ts:131,`OnScopeCreated=0`/`OnDemand=1`)、`createScopedChildHandle`(:153)、`Scope`(:181,`createApp`/`createChild`/`dispose`)、`IScopeHandle`(:111) |
| `fiber.ts` | Fiber 单元协议:服务/单元以 recipe 形式提供,`provide/effect/on/get/ref` 五种能力,句柄可 await、可 update(config)、可 dispose | `Fiber`(:67)、`FiberHandle`(:89,thenable,激活后 settle)、`FiberState`(:20,Pending/Activating/Active/Unloading/Failed)、`ServiceRecipe`(class/function/object 三形态,:41-60)、`RecipeStatics`(`name`/`inject`/`Config`/`meta`,:34)、`ScopeUnits(kind)`(:705,每 scope 一个 `CollectionToken<ServiceRecipe>`)、`FiberHost`(:153,容器侧宿主接口) |
| `service.ts` | `Service` 抽象基类:继承即获得 Fiber 能力;构造期调用被缓冲(`PendingFiberHandle`),构造完成由 `bindServiceUnit` 回放;**构造期只写不读**(`get/ref` 抛 `FiberProtocolError`);`new` 手动构造的实例无能力 | `Service`(:24,extends `Disposable` implements `Fiber, UnitInternals`)、`SERVICE_MARK` 原型标记(fiber.ts:132,service.ts:138) |
| `collection.ts` | 多提供者贡献点:`collection(name)` 铸造 token,任何 Fiber 可 `provide(token, value)`;token 可作构造参数装饰器注入 `CollectionView`;可见性 = 容器祖先/后代链(`_isRelated`);`definition(name)` = 单提供者校验的特化 | `CollectionToken`(:5)、`collection()`(:43)/`definition()`(:77)、`CollectionStore`(:123,根容器唯一)、`CollectionView`(:106,`items`/`records`/`onDidChange`)、`DefinitionView`(:30,`current`/`onDidChangeDefinition`) |
| `cascadeEngine.ts` | 跨 scope 的响应式事务引擎:provide/unprovide/update 变更入队整批执行,按依赖图算受影响集,逆拓扑拆除→应用变更→定点重建,全程记录历史 | `CascadeEngine`(:183)、`CascadeTree`(:114,全树共享队列/在途集)、`CascadeChange`(:19)、`UnitState`(:13)、`CascadeHistoryEntry`(:29,环形容量 200)、`onWillCascade` abort 钩子(默认等 5s,:110/527-558)、`resolveWhenAvailable`(30s 超时,:343)、`suspendActivation/resumeActivation`(:307/311,scope 装配期挂起、恢复时定点重检) |
| `dependencyGraph.ts` | 运行时实例级依赖图(非 v1 的静态 ctor metadata 图):scoped token 节点 + instance/collection 两种边;提供受影响集、拓扑/逆拓扑序、找环 | `DependencyGraph`(:59)、`ScopedToken`(:3)、`DependencyEdgeKind = 'instance' \| 'collection'`(:8);**注意**:`affectedSet`(:112)只沿 `instance` 边传播 |
| `scopeUnits.ts` | `watchScopeUnits(container, kind)`(:15):scope 创建时挂接,把 `ScopeUnits(kind)` collection 里的 recipe 记录物化为真实单元(class → `constructService`,function/object → 包 `FiberRuntime` facade),provider 死亡即回收(reconcile 循环) | 无导出类型;被 `scope.ts` 三处创建路径调用(scope.ts:165、220、258) |

容器新增 API 面(`IInstantiationService`,instantiation.ts:171-200):`cascade`、`provide(id, x, {activation, config})`、`provideAll(entries)`、`unprovide(id)`、`disposeAsync()`;新依赖种类 `DependencyKind = 'instance' | 'collection' | 'ref'`(instantiation.ts:7),`@ref(id)` 注入 `LiveRef<T>`(:136-150,弱观察句柄)。

对照 v1 的图景,概念跳跃在于:注册不再是模块级数组,而是*带作用域、带生命周期的单元*——可以随 scope 创建激活或按需激活,可以用新 config 更新(依赖它的单元随之定点重建),可以单独 dispose,也可以通过 contribution collection 被发现。

## 3. LifecycleScope 层级与单元生命周期

### 3.1 事实核查(先读):本基线是**三层** DI scope,不是四层

- `packages/agent-core-v2/src/app/scopes.ts:3-13`:`LifecycleScope` 枚举只有 `App` / `Session` / `Agent` 三个成员,`SCOPE_TOPOLOGY` 三元素并 `setScopeTopology`。
- 全仓无 `LifecycleScope.Workspace`;`Scope.createChild` 强制子 kind 在拓扑中大于父 kind(scope.ts:240-248)。生产派生点仅两处:`workspace/sessionLifecycle/sessionLifecycleService.ts:264`(`createScopedChildHandle(..., LifecycleScope.Session, sessionId, ...)`)、`session/agentLifecycle/agentLifecycleService.ts:156`(`createScopedChildHandle(..., LifecycleScope.Agent, agentId, ...)`)。
- 工作区级能力不是 DI scope:`Program`(`src/program/program.ts:113`)是每 workspace 一个的 generation 对象(持有 state/dirs/fs/watch/git/instructions/mcp/skills/agentProfiles),`IWorkspaceInstanceManager` 注册在 **App** scope(`workspace/workspaceInstance/workspaceInstanceManagerService.ts:312`)。
- **注意（已于 2026-09-19 解决）**：主文档 `packages/agent-core-v2/docs/migration-from-v1.md:21` 的早期版本写 "four LifecycleScope tiers (App / Workspace / Session / Agent, `src/app/scopes.ts`)"，与同基线代码不符（代码为三层；Workspace 是 Program/generation 概念）。主文档已更正为三层；本文按代码事实写。
- 历史语境:agent-domain-model migration 目标终态是**两层**(App→Session,Agent DI scope 删除),但 remaining agent domains 于 2026-09-07 归档放弃(见 §5),`LifecycleScope.Agent` 在本基线仍有 54 处使用(如 `agent/loop/loopService.ts:1590`、`wire/wireService.ts:377`、`state/eventDispatcherService.ts:857`)。
- 另有一处**非 LifecycleScope** 的裸 `createChild`:`runtime/runtimeUnitHost.ts:271`(runtime 单元事务的隔离子容器,属 execution-runtime 设施,不进 scope 拓扑)。

### 3.2 Scope 派生与销毁链

- **App**:`bootstrap(input, extraSeeds?)`(`app/bootstrap/bootstrap.ts:138`)→ `createAppScope`(scope.ts:298 → `Scope.createApp`:213)→ `new InstantiationService(collection, /* strict */ true)`,种子含 `IBootstrapOptions`、storage、skill discovery(bootstrap.ts:125-161)。
- **装配时序**(三层创建路径同构,scope.ts:213-230/238-273):`cascade.suspendActivation()` → `watchScopeUnits` → `configureContainer?` → `provideScopeServices`(把 `_scopedRegistry` 中该 kind 的条目经 `provideAll` 灌入,激活策略映射 `OnScopeCreated→'eager'` / `OnDemand→'ondemand'`)→ `resumeActivation()`(定点重检,eager 单元按拓扑序物化,cascadeEngine.ts:324-341/666-707)。
- **Session 派生**:`sessionLifecycleService.ts:241-299`,种子含 `ISessionContext`、telemetry 绑定、agentProfileCatalog、skill catalog、instructions、`ISessionMcpHandle`、workspace info、ephemeral MCP servers;`configureContainer` 内发 `_onWillCreateSession`,参与者可 `contributeSeed` / `onSessionDispose`(:287-296)。
- **Agent 派生**:`agentLifecycleService.ts:130-208`,种子含 `IAgentScopeContext`(`agentId+generation+forkedFrom`)、telemetry 绑定、`IAgentRuntimeBindingSeed`;随后 `IWireService.seal()`、注册 roster、发 `onDidCreate` / `onDidCreateScope`。
- **销毁**:`Scope.dispose()`(scope.ts:279)→ 自有 `Ledger.teardown('scope-close')` → 登记项含 `instantiation.dispose` 与子 scope 回收(scope.ts:196-202、269-271);`InstantiationService.disposeCore`(:666-695):子容器递归 `disposeAsync` → 本容器 `Ledger.teardown` → `_services.dispose()` → `cascade.dispose()` → collection views 销毁;`Ledger`(`_base/lifecycle/ledger.ts:37`)是有标签、有序的资源账簿(`register`:63 / `effect`:73 / `teardown`:123 / `clear`:140 / `release` 单项注销)。

### 3.3 Service/Fiber 单元生命周期

- 状态机:`FiberState`(fiber.ts:20)/ `UnitState`(cascadeEngine.ts:13):`Pending → Activating → Active → (Unloading)`,`Failed` 旁路。
- 激活:eager 单元在 scope 装配/cascade 事务的定点重检中按拓扑序物化(`_activate`,cascadeEngine.ts:709);ondemand 单元在首次 `accessor.get` 时物化,cascade 经 `observedMaterialization`(:374)补记状态。
- 构造协议:class recipe 经 `constructService` 构造时推入 `ConstructionFrame`(fiber.ts:111-130);`Service` 基类构造期的 `provide/effect/on` 调用入 `__unitBuffer`,构造完成后 `bindServiceUnit`(fiber.ts:199)回放并绑定 `FiberRuntime`;此后所有能力记账到单元自有 `Ledger`(`unitBook`),随单元 teardown 整体回收。
- 更新与拆除:`FiberHandle.update(config)` 触发 `updateToken` → cascade `update` 事务:受影响集逆拓扑 `_teardownForCascade`(挂回 Pending)→ 应用新 config → 定点重建;`handle.dispose()` / scope 关闭经 Ledger 条目触发 `core.dispose()`(fiber.ts:401-420)。config 经标准 schema 校验(`Config` static,`~standard.validate` 必须同步,fiber.ts:229-247)。
- 句柄语义:`FiberHandle` 是 thenable——`await handle` 等激活后得到 settled 视图(fiber.ts:603-644);失败单元 settle 时 reject。

## 4. Feature 缝:注册与装配

四个机制文件(`src/features/`)+ 管理面(`src/app/feature/`):

1. **`features/feature.ts:38`** — `abstract class Feature extends Service`。`contribute*` 系列全是往 collection token 投记录的糖:
   - `contribute(token, value)`(:39)→ 任意 `CollectionToken`;
   - `contributeSessionModel` / `contributeAgentModel`(:43/:47)→ `SessionModelContribution` / `AgentModelContribution`(`#/state/agentModel`);
   - `contributeConfig(domain, schema)`(:53)→ `ConfigSectionContribution`;
   - `contributeService(scope, id, ctor, opts)`(:65)→ 先投 `FeatureServiceContribution` 记录(可发现性元数据),再投 `ScopeUnits(scope)` 一个 object recipe(`apply(fiber) { fiber.provide(id, ctor, opts) }`)——服务随目标 scope 的创建/record 存活而物化/回收(scopeUnits.ts 机制);`contributeAgentService` = Agent scope 特化(:80);
   - `contributeTool(id, ctor, options)`(:88)→ Agent scope OnDemand 服务 + `AgentToolContribution` 记录;
   - `contributeCommand` / `contributeProfiles`(:99/:103)→ `CommandContribution` / `AgentProfileContribution`。
2. **`features/featureRegistry.ts:5`** — `registerFeature(recipe)` 模块级全局 recipe 表(`_featureRecipes`),`getFeatureRecipes()` 读出。本基线共 **18 个 Feature** 自注册:btw、contextBudget、cron、dateChange、debugEvents、externalHooks、fileHistory、goal、interaction、plan、reminder、sessionInit、skill、swarm、todo、tokenCounting、tower、usage(各 `features/<name>/<name>Feature.ts` 文件底部)。
3. **`features/featureAssembly.ts:7`** — `IFeatureAssemblyService` token(空接口,仅装配触发器)。**`features/featureAssemblyService.ts:9`** — `FeatureAssemblyService extends Service`,注册在 **App scope + `ScopeActivation.OnScopeCreated`**(:20-26);构造时注入 `@IFeatureManager`,把 `getFeatureRecipes()` 逐个 `featureManager.provideUnit(recipe)`(:12-17)。即 **App scope 创建 → eager 激活 → 全部 Feature 实例化并执行其构造期 contribute**。
4. **`app/feature/featureManager.ts:19`** — `IFeatureManager`:`provideUnit(recipe|id+ctor, opts)` / `unprovideUnit(name)` / `updateUnit(name, config)` / `units()` / `contributedServices()` / `onDidChangeUnits`。**`featureManagerService.ts:23`** — 实现(App scope, OnScopeCreated,:107-113);同名 unit 替换会先 dispose 旧 handle(:57-59);经 `@FeatureServiceContribution` 注入 `CollectionView<ContributedFeatureService>`(:34)回答可发现性查询。**`featureServiceContribution.ts:10`** — `collection('feature-service')`,校验同 `(scope,id)` 唯一(重复抛错)。
5. **加载方式**(组合根):`src/index.ts` 顶部对各 `*Feature` 模块的 **side-effect import**(如 `import '#/features/todo/todoFeature'`,index.ts:747;共 18 处)+ `import '#/features/featureAssemblyService'`(index.ts:273)——import 包根即完成 recipe 注册与 assembly 服务注册,与 v1 的 barrel 副作用注册同构。

Feature 卸载语义:`unprovideUnit` dispose Feature handle → Feature 自身 Ledger 回收其全部 provide(ScopeUnits 记录、collection 记录)→ 目标 scope 的 `watchScopeUnits` reconcile 回收已物化服务;`FeatureServiceContribution` 元数据随 provider 死亡从 view 消失(v2 scan 修复后语义)。

## 5. 迁移史:关键架构决策与时间线

来源:对应工作项决策记录(v2 agent-rpc removal、kap edge adapters、v2 scan、agent-session-domain、agent-domain-model migration、remaining agent domains、remove agent-core v1)的背景/决策部分 + 主文档。这些决策记录不在本仓库内;时间线可核验,决策原文依据见下。

### 5.1 时间线

| 时间 | 事件 | 证据 |
|---|---|---|
| 2026-08-12 | **v2 agent-rpc removal**(PR #2871 已合):删除 v2 引擎内 `src/agent/rpc/` 5 文件聚合层,12 方法的非平凡逻辑下沉领域 Service,klient/node-sdk/kap-server 全改直连 | PR #2871 |
| 2026-08-13 | **v2 scan**(PR #2886):Feature 贡献的可发现性元数据随 provider 生命周期撤回;用户决定「同 `(scope,id)` 只允许一个 provider,重复立即报错」 | PR #2886 |
| 2026-08-17 → 08-20 | **agent-session-domain**(PR #3103,08-20 合入 `a09d9041`):确立「每个 Domain 自己成为 Feature」目标架构;Model-as-container 第一阶段(`AgentModel`/`defineAgentModel`/`AgentContext.space`);`AgentEvent2`(agentId 入 payload)+ Session 单 EventBus;Todo/Usage/TokenCounting 首迁 | PR #3103 |
| 2026-08-20 → 08-23 | **agent-domain-model migration**(PR #3175,08-23 合入 `368b4b74`):交付 Agent Runtime 基础设施(opaque contract/provider、`AgentLifecycleService→ManagedAgent→AgentRuntimeSet`、restore 唯一 owner)+ Todo/Cron/Interaction 迁 Runtime;goal/skill/reminder/dateChange 随后合入 | PR #3175 |
| 2026-08-25 → 09-07 | **remaining agent domains**(PR #3303,**2026-09-07 关闭未合**):剩余全部 Agent 域迁 Agent Runtime、Step 13 消灭 Agent DI scope 改 `AgentHost` 显式构造对象(工作副本曾完成);**2026-09-07 用户决策:不再使用这种重构路线,工作项归档** | PR #3303(关闭未合) |
| 2026-09-01 → 09-07 | **remove agent-core v1**(PR #3542):删除 `packages/agent-core`(687 文件),node-sdk 全面迁 v2(契约自有化 17 模块),`createKimiHarnessV2` 改名 `createKimiHarness` 唯一工厂,`KIMI_CODE_LEGACY_FLAG` 与 vscode `useAgentCoreV1` 随删;rebase 基线即本文档检出点 `ccf3d5d6` | PR #3542 |

补充事实:本基线 v2 包内 `docs/features.md`(旧 Agent Runtime 实现标准)**已不存在**(documentation cleanup 删除);基线时点 `docs/` 仅有 wire/state/config manifest,本迁移指南(EN/中)是在该基线之上新增。

### 5.2 关键架构决策(原文依据)

**为什么 RPC 出引擎**(v2 agent-rpc removal,用户故事即决策记录):

- 「删除 facade 式聚合的 `AgentRPCService`,消除"边缘该走 RPC 还是直连领域 service"的双轨心智负担,让编排逻辑只存在于领域 Service 一处」(v2 agent-rpc removal 决策记录);
- 「wire 契约与进程内调用语义一致……不依赖"Promise 能否过 wire"这类隐式知识」(`PromptHandle.launched` 含 Promise,`Turn` 过不了 klient wire)(同一决策记录);
- 落点:协议类型 → `packages/protocol` + `packages/klient`,server 实现 → `packages/kap-server`,进程内事件 → `IEventBus` + `Event2`(主文档 §2.4 表)。

**为什么单进程**:

- 直接证据是结果性陈述:主文档 A.1「`services/` … `coreProcess/` gone (v2 is single-process)」、A.3「`coreProcess` → gone (v2 is in-process DI, with kap-server at the edge)」;v1 侧 `CoreProcessService` 是持有 `CoreRPC` mega-proxy 的跨进程 adapter(`services/coreProcess/coreProcess.ts:1-29` + services/AGENTS.md:38 角色表)。
- kap 分层(进程内 adapter 形态)决策见 kap edge adapters 工作项:2026-08-13 用户拍板架构图,全部 adapter 落 `kap-in-memory` 直连引擎包。**待核**:「单进程」作为一条显式「为什么」的决策原文未在四份指定决策记录中出现;可引用的是上述结果性陈述与 kap edge adapters 的架构图决议。

**为什么不留兼容层**:

- agent-domain-model migration 继承约束(用户决定):「已提交或后续仍使用 `IAgentXxx`/`AgentXxxBinding` 的兼容桥必须随 Runtime 迁移删除,**不新增通用 alias 作为同义过渡层**;调用方直接改走 execution context 或 `AgentManager.resolve`」(agent-domain-model migration 决策记录);
- remaining agent domains:「features.md 禁止留 DI facade 过渡,每条反向边须随对应域的迁移提交同 changeset 翻转」(决策记录);「过渡桥统一落在未迁移旧服务内部……不在新 Runtime 侧留兼容接口」(同一决策记录);
- 工程纪律成文:主文档 §3.3「不在 v2 引擎内为 v1 形状加兼容层。兼容层只能长在消费方」;根 AGENTS.md「when refactoring, do not assume compatibility costs — design for the lowest global complexity」;
- 终局形态:remove agent-core v1 连 v1 包本身带 `KIMI_CODE_LEGACY_FLAG` 一并删除,「v2 无条件生效」(remove agent-core v1 决策记录)。

**为什么 Feature 缝**:

- agent-session-domain 背景:「不是把能力搬进一个新的 Session facade、registry 或 runtime bundle,而是让每个 Domain 自己成为一个 Feature:Domain Feature 注册自己的 Model、Effect、Event、Tool 和 Session Service;Domain Service 自己消费这些 contribution」(agent-session-domain 决策记录);用户约束「不引入负责跨 Domain 集成、bind 或 materialize 的 facade、registry、RuntimeBundle 或等价中心对象」(决策记录);「Domain Feature 只登记 definition,不在 install 时创建未来 Agent 的运行时实例」(同一决策记录);
- 与 v1 services 层的关系:Feature = App scope 的一个 Fiber 单元(`Feature extends Service`),贡献即投 collection 记录,物化/回收由基础设施(ScopeUnits watcher、cascade)托管——对照 v1「impl 文件底部 `registerSingleton` + 根容器一次性播种」的静态全开模式,v2 的注册单元带生命周期(可卸载、可更新 config、可被发现性查询)。
- **关键警告**:agent-domain-model migration 与 remaining agent domains 把 Agent 粒度扩展点进一步收窄为 `contributeAgentRuntime(definition)` 单参数形态(决策记录),**但该路线随归档未落地**;本基线的 Feature 缝即 §4 所列机制(contributeService/Tool/Config/Model 等),Agent 粒度仍是 DI scope。这些工作项描述的目标终态——Agent Runtime / `AgentHost` 两层拓扑(App→Session,删除 Agent DI scope)——**从未合入 main**,此处仅作历史决策背景记录。本基线现状 = **三层 DI LifecycleScope(App / Session / Agent)+ 工作区级 Program generation 概念 + Feature 缝**。阅读时不得把目标终态当作现状。

## 待核清单

1. ~~**「四层 LifecycleScope」表述**~~（已于 2026-09-19 解决）：主文档（`migration-from-v1.md:21` 及中文镜像 :21）已更正为三层（App / Session / Agent；工作区级 = `Program`，`program/program.ts:113` + App-scope `IWorkspaceInstanceManager`）。
2. **「为什么单进程」的原始决策出处**:四份指定决策记录中无专条;现有证据为主文档(A.1/A.3)的结果性陈述 + kap edge adapters 决策记录中的用户架构图决议。若需更强的一手「为什么」,可查初始 v2 建包决策记录或更早 v2 建包工作项的记录(本文未展开)。
3. **v2 包创建时间**:v2 agent-rpc removal(2026-08-12)时 v2 已存在;建包工作项本身不在四份指定文档内,时间线起点标「不晚于 2026-08-12」。
4. remaining agent domains 的 Agent Runtime/`AgentHost` 终态(两层拓扑)**未合入 main**,写作时须避免把目标终态描述为本基线现状;本基线现状 = 三层 DI scope + §4 的 Feature 缝。
5. **基线后漂移(待核)**:§5.2 的 `packages/protocol` 引用已在声明基线 `ccf3d5d6` 核实;在当前工作区检出(#3542 之后的 main)中,该包已不在原位置。决策叙述仍是基线事实;该包的基线后去向待核。
