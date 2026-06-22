# Scope 机制设计定稿

本文是 di-v3 的**横切 scope 机制定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、注册 / 构建 / 析构的统一流程、跨 scope 通讯的方向和决策记录。

本文是 P1（scope 机制实施）的直接依据。P1 worker 应能按本文逐条落地 `LifecycleScope` / `ScopeRegistry` / `registerScopedService` / `I*Context` / `ScopeBuilder` / manager 模式。

权威来源（本文对它们做规范化整理，命名以本文为准）：

- `/Users/moonshot/Projects/kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md`
- `/Users/moonshot/Projects/kimi-code-dev-2/plan/2026.06.21-Domain 和 Scope 的划分.md`

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [拆分概览](#拆分概览)
- [统一流](#统一流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里：

- **Scope 与 Domain 是两个正交维度**。Domain 回答“这个 Service 在讲什么事”（Kosong / Kaos / Loop / Permission / Agent / …）；Scope 回答“这个 Service 实例什么时候创建、什么时候释放”（Core / Session / Agent / Turn / ToolCall）。一个域可以同时拥有多种 scope 的 Service 实例。
- **每个 scope = 一个子 InstantiationService（child container）**。child 找不到的 service 沿 parent 向上找。Scope 的身份通过一个“context service”注入，service ctor 拿身份，方法签名不再带 id。
- **只暴露一个注册 API：`registerScopedService(scope, id, ctor, type, options?)`**。注册是 lazy 的（写入 `ScopeRegistry`，不实例化）。`registerScopedService(Core, ...)` 等价于 `registerSingleton(...)`，保留以让 5 个 scope 用法一致。
- **每个 child scope 在父 scope 里有一个 manager service**。manager 是它所管 scope 的唯一上行事件发布点，通过 `child.accessor.get(...)` 主动订阅 child 内的事件源并 re-emit 成集合视图事件（加 child id）；child 永不反向调用 manager 的写方法。
- **`scope.dispose()` 与 manager `onDid*` 事件同步配对**：`try { await dispose() } finally { fire onDid*; eventBus.publish(...) }`。`onWillDispose` 在数据还在时触发（抓 snapshot），`onDidDispose` 在数据已没时触发（只更新自己状态）。

接口定义见 P1 实施产物（`packages/agent-core/src/scope/`），本文只承载跨 scope 的概念叙述。

## 第一性原理

### 1. 域与 scope 必须分开

同一个域的不同 Service 实例可以散在不同 scope。例：`IUsageService` 属于 Kosong 域（讲模型用量），但实例分散在 Core scope（跨 session 聚合）和 Agent scope（每个 agent 一份累计 view）。硬把“域 = 同一 scope”会同时牺牲概念清晰和资源管理。

### 2. 一个 scope = 一个 child container

不用“Core scope 单例 service 内部持 `Map<agentId, State>`”。每个 scope 是一个子 InstantiationService，里面的 service ctor 通过 DI 拿到 `IAgentContext` / `ISessionContext` / `ITurnContext` / `IToolCallContext` 当身份。这样：

- 方法签名不带 id（无 API 噪声）；
- 拿错身份由编译器 / 容器解析顺序保证（隔离不失效）；
- dispose 由 child container 统一调度（无 boilerplate）。

### 3. 身份走 context service，方法不带 id

每个 scope 暴露一个 `IXxxContext` decorator service。service ctor 通过 `@IAgentContext` 等注入身份；业务方法签名**不**携带 `agentId` / `sessionId` / `turnId` / `toolCallId`（例外见 [依赖方向与边界](#依赖方向与边界) 的不变量 14）。

### 4. 注册与构建分离

- **注册**（`registerScopedService`）：在模块 import 时同步执行 side-effect，只写 `ScopeRegistry`，不实例化。
- **构建**（`ScopeBuilder.build`）：从 registry 读出 descriptor，包成 `SyncDescriptor` 装进 child container，lazy 实例化。

所有 builtin / 上层包注册必须发生在**第一次 `ScopeBuilder.build()` 之前**。

### 5. 下行生命周期走 DI，上行通知走 manager

- **下行**：父 scope 调 `childHandle.dispose()`，DI 容器自动调每个 service 的 `.dispose()`。
- **上行**：child scope 的 manager service（住父 scope）是**唯一**上行事件发布点。child 内 service 发本地 typed event（不带 id），manager 在订阅 callback 里 re-emit 成集合视图事件（带 id）。

### 6. ctor 不做 IO

scope build 链可能创建几十个 service；任何 ctor 阻塞都会拖慢 agent 创建延迟，且测试时 mock 一份 fake collection 不能跑真 IO。ctor 只允许：订阅同 scope / 父 scope 的 typed event（同步 wiring）；`accessor.get(...)` 拿依赖但不调耗时方法。重活推到首次方法调用或专门的 `init()`。

### 7. 跨 scope 数据不共享 Service

不允许一个 Service 同时存在于两个 scope。所有“既需要 Core 聚合又需要子 scope 视图”的场景必须拆两个独立 Service（Core 一份 + child scope 一份），由上层同时调两边。

## 拆分概览

### LifecycleScope 枚举

5 个核心 scope。User / Project 是 Core scope 的持久化子集（不是独立 DI scope）；Background-task 是 Agent scope 的延迟释放变种；Subagent 是 Agent scope 的另一个实例 + 所有权关系。它们都不是新 scope。

| Scope | 含义 | 创建时机 | 释放时机 | 基数（cardinality） | 典型成员 |
|---|---|---|---|---|---|
| `Core` | 进程级 | 进程启动 | 进程退出 | 每进程 1 份 | `IChatProviderService` / `IModelCatalogService` / `IKaosRegistryService` / `IPermissionRegistry` / `ITurnService` 注册中心 / 底层 `IUsageService` / `ILogService` / `IEventService` |
| `Session` | 一次会话 | `session.open` | `Session.close()` | 每 Session 1 份 | `IMcpConnectionManagerService` / `ISessionSkillRegistry` / `ISessionLogService` / `IApprovalService` / `IWorkspaceService` / `IHookEngine`（Session 实例）/ Session-scoped `GrantStore` |
| `Agent` | 一个 agent 实例 | agent 创建 | `Agent.dispose()` | 每 Agent 1 份 | `IContextMemoryService` / `IToolManager` / `IPermissionManager` / `PlanMode` / `GoalMode` / `IBackgroundService` / `ICronService` / `ICompactionService` / `IRecordsService` / `UsageView` / `TurnFlow` |
| `Turn` | 一轮推进 | `turn.start` | turn 结束（success / abort / error） | 每 Turn 1 份 | `ActiveTurn` / `TurnHandle` / `AbortController` / LLM stream / `KosongLLM` / `ProviderRequestAuth` / `ExecutionScope` / `once` / `turn` grant / per-turn `LiveEventBus` |
| `ToolCall` | 单次工具调用 | tool 调用准备 | 单次 tool 调用结束 | 每次 tool call 1 份 | `once` permission grant / `prepareToolExecution` 临时 buffer / 单次 approval prompt 句柄 / 单次 tool 执行的 child `AbortController` |

枚举定义（normative）：

```ts
export enum LifecycleScope {
  Core     = 'core',
  Session  = 'session',
  Agent    = 'agent',
  Turn     = 'turn',
  ToolCall = 'toolCall',
}
```

嵌套关系：

```text
Core Scope (root IInstantiationService)
  ├─ Session Scope A (child of Core)
  │    ├─ Agent Scope A1 (child of Session A)
  │    │    └─ Turn Scope A1-t1 (child of Agent A1)
  │    │         └─ ToolCall sub-scope A1-t1-c1 (child of Turn)
  │    └─ Agent Scope A2
  └─ Session Scope B
       └─ ...
```

DI 解析顺序：child 找不到的 service 沿 parent 向上找，最终到 Core。

### ScopeRegistry

进程级、单例、两张表的嵌套结构：

```ts
type ServiceId<T> = ServiceIdentifier<T>;          // createDecorator 的产物
type SyncDescriptor = SyncDescriptor0<unknown>;     // ctor + 静态参数 + supportsDelayed

class ScopeRegistry {
  // process-wide；每个 scope 一张 (id -> descriptor) 表
  private readonly tables = new Map<LifecycleScope, Map<ServiceId<unknown>, SyncDescriptor>>();

  register(scope, id, descriptor): void;            // 写入（lazy，不实例化）
  descriptors(scope): Iterable<{ id; descriptor }>; // ScopeBuilder 读取
  has(scope, id): boolean;
}
```

性质：

- `ScopeRegistry` 是 process-wide 单例（模块级常量）。测试可 reset，但生产进程里只有一份。
- 写入是 lazy 的：只存 `SyncDescriptor`，**不** `new`。
- 读取入口只对 `ScopeBuilder` 暴露；业务代码不直接读 registry。

### `registerScopedService` API（Pattern 1）

唯一对外注册 API（仿 VSCode `registerSingleton`）：

```ts
export function registerScopedService<T>(
  scope: LifecycleScope,
  id: ServiceIdentifier<T>,
  ctor: new (...args: never[]) => T,
  type: InstantiationType,                 // 默认 Delayed
  options?: { replace?: boolean },
): void;
```

行为契约：

1. **写入 registry（lazy）**：`registry.register(scope, id, new SyncDescriptor(ctor, [], /* supportsDelayed */ true))`。不实例化。
2. **Core 别名**：`registerScopedService(LifecycleScope.Core, id, ctor, type)` 等价于 `registerSingleton(id, ctor, type)`，内部直接走现有 `registerSingleton`。保留以让 5 个 scope 用法一致。
3. **重复注册 last-write-wins + warn**：同 `(scope, id)` 重复注册时，默认打 `warn`（“duplicate registration for <id> in <scope>, last write wins”），但仍覆盖。
4. **`{ replace: true }` 静默覆盖**：显式声明“我知道我在替换”，registry **不**打 warn。用于 plugin 覆盖 builtin。
5. **注册时机**：必须在第一次 `ScopeBuilder.build()` 之前。之后注册 `warn` + 忽略（避免构建到一半的 scope 拿到不一致的 descriptor）。

典型用法：

```ts
// agent-core/goal/goalService.ts（builtin）
registerScopedService(
  LifecycleScope.Agent,
  IGoalService,
  GoalService,
  InstantiationType.Delayed,
);

// plugin-X 覆盖 builtin（load order 晚于 builtin）
registerScopedService(
  LifecycleScope.Agent,
  IGoalService,
  EnhancedGoalService,
  InstantiationType.Delayed,
  { replace: true },
);
```

未来扩展（本版不实现，builder pipeline 已预留）：Pattern 2 `registerScopeBuildHook(scope, hook)` / Pattern 3 pre-build interceptor。见 [统一流](#统一流) step 3 / 4。

### Scope identity contexts

每个 scope 一个 `IXxxContext` decorator service。normative 字段统一为 `id` / `parentId` / `abortSignal` / `executionScope`（来源文档用 `sessionId` / `agentId` / `signal` 等按 scope 命名的字段，本文归一化；见 DR10）。

```ts
// createDecorator 产物；service ctor 通过 @ISessionContext 等注入
interface ISessionContext {
  readonly id: string;                    // sessionId
  readonly parentId: undefined;           // Session 的父是 Core，无业务父 id
  readonly abortSignal: AbortSignal;      // 等价于 session scope 的 onWillDispose
  readonly executionScope: IExecutionScope;
}

interface IAgentContext {
  readonly id: string;                    // agentId
  readonly parentId: string;              // sessionId
  readonly abortSignal: AbortSignal;
  readonly executionScope: IExecutionScope;
}

interface ITurnContext {
  readonly id: string;                    // turnId
  readonly parentId: string;              // agentId
  readonly abortSignal: AbortSignal;      // ESC / abort 触发的 cancel
  readonly executionScope: IExecutionScope;
}

interface IToolCallContext {
  readonly id: string;                    // toolCallId
  readonly parentId: string;              // turnId
  readonly abortSignal: AbortSignal;
  readonly executionScope: IExecutionScope;
}
```

消费侧：

```ts
class GoalService implements IGoalService, IDisposable {
  constructor(
    @IAgentContext private readonly ctx: IAgentContext,
    @IRecordsService private readonly records: IRecordsService,
  ) {}

  async create(spec: GoalCreateSpec, actor: GoalActor) {
    // 不需要 agentId 参数；this.ctx.id 是隐式的
    await this.records.append({ kind: 'goal-created', agentId: this.ctx.id, /* ... */ });
  }

  dispose() { /* 由 child container 在析构时自动调用 */ }
}
```

### Scope handle

每个 builder 返回的 handle：

```ts
interface IScopeHandle extends IDisposable {
  readonly id: string;                              // 本 scope 的 identity id（== context.id）
  readonly scope: LifecycleScope;
  readonly accessor: IServiceAccessor;              // child container 的 accessor
  readonly onWillDispose: Event<{ reason?: string }>; // 数据还在
  readonly onDidDispose: Event<{ reason?: string }>;  // 数据已没
  dispose(reason?: string): Promise<void>;
}
```

## 统一流

### ScopeBuilder 4 步 pipeline

每个 scope 一个 builder（`SessionScopeBuilder` / `AgentScopeBuilder` / `TurnScopeBuilder` / `ToolCallScopeBuilder`），同模式：

```ts
class AgentScopeBuilder {
  build(parent: IInstantiationService, identity: AgentScopeIdentity): IAgentScopeHandle {
    const collection = new ServiceCollection();

    // ① inject scope identity context
    collection.set(IAgentContext, identity.context);

    // ② install Pattern-1 statically registered services as SyncDescriptors
    for (const { id, descriptor } of registry.descriptors(LifecycleScope.Agent)) {
      collection.set(id, descriptor);
    }

    // ③ reserved build hook（Pattern 2，本版未启用）
    // for (const hook of buildHooks.get(LifecycleScope.Agent)) hook(collection, identity);

    // ④ reserved post-build interceptor（本版未启用）
    // for (const interceptor of postBuildInterceptors.get(LifecycleScope.Agent)) interceptor(collection, identity);

    const child = parent.createChild(collection);
    return new AgentScopeHandle(child, identity);
  }
}
```

性质：

- step ② 的 descriptor 全部走 `SyncDescriptor` + lazy：不用的 service 不占内存；首次 `accessor.get(IXxx)` 时才 `new`。
- step ③ / ④ 是预留位，本版不实现。未来加 Pattern 2 / 3 时只需在这两步迭代 hooks / interceptors，已注册的 Pattern 1 调用方零修改。
- `parent.createChild(collection)` 创建 child container；返回的 handle 包 `accessor` + 两个 dispose 事件。

### SyncDescriptor + lazy 实例化

```ts
collection.set(IGoalService, new SyncDescriptor(GoalService, [], /* supportsDelayed */ true));
```

### ctor 约束（强约束）

- **禁止**：ctor 做 IO（文件读取、网络、shell exec）。
- **允许**：ctor 订阅同 scope / 父 scope 的 typed event（同步 wiring）。
- **允许**：ctor `accessor.get(...)` 拿依赖，但**不**调对方的耗时方法。
- 重活推到首次方法调用或专门的 `init()`。

理由：scope build 链可能创建几十个 service；任何 ctor 阻塞都会拖慢 agent 创建延迟，且测试时 mock 一份 fake collection 不能跑真 IO。

### `dispose()` 流 + manager `onDid*` 配对

`IScopeHandle.dispose()` 内部：

```ts
async dispose(reason?: string): Promise<void> {
  if (this.disposed) return;
  this.disposed = true;

  // [1] fire onWillDispose，await 全部 listener（数据还在）
  await fireAsync(this.onWillDisposeEmitter, { reason });

  // [2] 析构 child container（DI 自动调每个 service 的 .dispose()）
  this.child.dispose();

  // [3] fire onDidDispose（同步；数据已没）
  this.onDidDisposeEmitter.fire({ reason });
}
```

manager 调 dispose 时必须配对 onDid\* + wire publish（强约束）：

```ts
class TurnService {
  async abort(turnId: string, reason: string): Promise<void> {
    const handle = this.active.get(turnId);
    if (!handle) return;
    try {
      await handle.scope.dispose(reason);
    } finally {
      this.active.delete(turnId);
      this.onDidCancelTurn.fire({ turnId, reason });
      this.eventBus.publish({ kind: 'turn.cancelled', turnId, agentId: this.ctx.parentId, reason });
    }
  }
}
```

两个 dispose 事件的语义分：

| 事件 | 时机 | 允许做什么 |
|---|---|---|
| `onWillDispose` | scope 即将析构，**数据还在** | 抓 snapshot（final usage / transcript flush / final goal state）。manager `await` 全部 listener 后才继续。 |
| `onDidDispose` | scope 已析构，**数据已没** | subscriber 只更新自己状态；**不允许**访问 child 内部 service。 |

### Manager 上行流（主动 attach 订阅）

manager service 住父 scope，是它所管 child scope 的唯一上行发布点。它通过 `child.accessor.get(...)` 主动订阅 child 内的事件源，再 re-emit 成集合视图事件（加 child id）：

```ts
class AgentLifecycleService {
  private readonly active = new Map<string, { handle: IAgentScopeHandle; childSubs: DisposableStore }>();

  async create(spec: AgentCreateSpec): Promise<IAgentScopeHandle> {
    const agentCtx = buildAgentContext(spec, this.sessionCtx);
    const handle = AgentScopeBuilder.build(this.sessionScope, agentCtx);

    // 关键：拿 child scope 的 per-agent event source，一次性挂订阅
    const childSubs = new DisposableStore();
    const agentStatus = handle.accessor.get(IAgentStatus);
    childSubs.add(agentStatus.onDidChange(({ previous, current }) => {
      // re-emit 成集合视图事件（manager 是唯一加 agentId 的“组合”点）
      this.onDidChangeAgentStatus.fire({ agentId: agentCtx.id, previous, current });
      this.eventBus.publish({
        kind: 'agent.status-changed',
        agentId: agentCtx.id,
        sessionId: this.sessionCtx.id,
        status: current,
      });
    }));

    this.active.set(agentCtx.id, { handle, childSubs });
    this.onDidCreateAgent.fire({ agentId: agentCtx.id, type: spec.type });
    return handle;
  }

  async dispose(agentId: string, reason?: string): Promise<void> {
    const entry = this.active.get(agentId);
    if (!entry) return;
    try {
      this.onWillDisposeAgent.fire({ agentId, reason });
      await entry.handle.dispose(reason);
    } finally {
      entry.childSubs.dispose();           // 一并解订阅，无 dangling
      this.active.delete(agentId);
      this.onDidDisposeAgent.fire({ agentId, reason });
    }
  }
}
```

per-scope event source 命名（child 内专门给 manager 订阅）：

| Scope | per-scope event source（住该 scope） | manager（住父 scope） |
|---|---|---|
| Session | （session 状态多维，无单一 self-view；manager 直接订阅 agents map / approval / question 等） | `ISessionLifecycleService` |
| Agent | `IAgentStatus`（derived from `ITurnService`） | `IAgentLifecycleService` |
| Turn | `ITurnHandle.signal`（abort 即 dispose）+ `ITurnService` 自身的 onDid\* | `ITurnService` |
| ToolCall | `IToolCallContext.signal` | `IToolCallScheduler` |

Turn / ToolCall 生命周期短，直接用 manager 自己的 onDid\* + scope handle 的 signal 就够，不需要再起 `ITurnStatus`。Agent scope 引入 `IAgentStatus` 是因为 status 由多源（turn 活跃度）派生，且 manager 在父 scope，必须有个 child 侧的发源给 manager 订阅。

per-scope event source **优先 derived**：能从已有事件派生的状态（如 `IAgentStatus` 从 `ITurnService.activeCount` 派生）不允许暴露 `setStatus` 写 API。

```ts
class AgentStatusService implements IAgentStatus {
  private _status: AgentStatus = 'idle';
  private readonly _onDidChange = new Emitter<{ previous: AgentStatus; current: AgentStatus }>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    @IAgentContext private readonly ctx: IAgentContext,
    @ITurnService private readonly turns: ITurnService,
  ) {
    const recompute = () => {
      const next: AgentStatus = this.turns.activeCount() > 0 ? 'running' : 'idle';
      if (this._status === next) return;
      const previous = this._status;
      this._status = next;
      this._onDidChange.fire({ previous, current: next });
    };
    this._disposables.add(this.turns.onDidStartTurn(recompute));
    this._disposables.add(this.turns.onDidFinishTurn(recompute));
    this._disposables.add(this.turns.onDidCancelTurn(recompute));
  }

  get status() { return this._status; }
  dispose() { this._disposables.dispose(); }
}
```

## 关键场景

### 场景 A：创建一个 Agent scope

```ts
const handle = agentLifecycleService.create(spec);
```

内部解析：

```text
AgentLifecycleService.create (Session scope)
  ├─ buildAgentContext(spec, sessionCtx)            // id / parentId / abortSignal / executionScope
  ├─ AgentScopeBuilder.build(sessionScope, ctx)
  │    ├─ collection.set(IAgentContext, ctx)        // ① identity
  │    ├─ for desc in registry.descriptors(Agent)   // ② Pattern-1 static
  │    ├─ (③ build hook 预留)
  │    ├─ (④ post-build interceptor 预留)
  │    └─ parent.createChild(collection)            // child container
  ├─ handle.accessor.get(IAgentStatus)              // manager 主动 attach
  ├─ active.set(agentId, { handle, childSubs })
  └─ onDidCreateAgent.fire({ agentId, type })
```

### 场景 B：dispose 一个 Agent scope

```ts
await agentLifecycleService.dispose(agentId, reason);
```

内部解析：

```text
AgentLifecycleService.dispose
  ├─ onWillDisposeAgent.fire({ agentId, reason })   // manager 旁路
  ├─ handle.dispose(reason)
  │    ├─ onWillDispose.fireAsync()                 // 数据还在：抓 snapshot / final flush
  │    ├─ child.dispose()                           // DI 析构每个 service .dispose()
  │    └─ onDidDispose.fire()                       // 数据已没：只更新自己 state
  └─ finally
       ├─ childSubs.dispose()                       // 解订阅，无 dangling
       ├─ active.delete(agentId)
       └─ onDidDisposeAgent.fire({ agentId, reason })
```

### 场景 C：注册 builtin service

```ts
registerScopedService(LifecycleScope.Agent, IGoalService, GoalService, InstantiationType.Delayed);
```

行为：模块 import 时同步执行 side-effect，写 `ScopeRegistry.tables[Agent][IGoalService]` = `SyncDescriptor(GoalService)`。不实例化。第一次 `AgentScopeBuilder.build` 之前必须完成。

### 场景 D：plugin 覆盖 builtin

```ts
// builtin load order 1
registerScopedService(LifecycleScope.Agent, IGoalService, GoalService, Delayed);
// plugin-X load order 2
registerScopedService(LifecycleScope.Agent, IGoalService, EnhancedGoalService, Delayed, { replace: true });
```

行为：第二次同 `(Agent, IGoalService)` 注册覆盖前者；因带 `{ replace: true }`，registry 静默覆盖、不打 warn。多 plugin 互相覆盖同一 service 时最后 import 的胜出，结果可能因 bundler 不同而变，不推荐。

### 场景 E：Core service 订阅子 scope 事件

Core scope 容器看不见 Session / Agent / Turn scope 的 service，所以 Core service 不能直接 inject child-scope manager。三条合法路径：

| 需求 | 推荐 |
|---|---|
| 上 wire 推到 TUI / daemon / 跨进程 | Pattern A：订阅 `IEventService`（Core scope），按 `event.kind` 过滤；丢强类型 |
| Core service 聚合 / 镜像 child scope 事件 | Pattern B：写 Core scope 的 typed aggregator + `InstantiationType.Eager`；保强类型，可在 payload 补 sessionId |
| 等某个特定 turn / agent 结束 | Pattern C：从已知 scope handle 拿 manager + `filter` by id |

aggregator 示例（Pattern B）：

```ts
class AgentLifecycleAggregator implements IAgentLifecycleAggregator {
  private readonly _onDidCreateAgent = new Emitter<AgentCreatedEvent & { sessionId: string }>();
  readonly onDidCreateAgent = this._onDidCreateAgent.event;

  constructor(@ISessionLifecycleService private readonly sessions: ISessionLifecycleService) {
    for (const h of this.sessions.list()) this._attach(h);   // 启动时已存在的 session
    this.sessions.onDidCreate(h => this._attach(h));          // 后续新创建的 session
  }

  private _attach(handle: ISessionScopeHandle) {
    const agentSvc = handle.accessor.get(IAgentLifecycleService);
    const sessionId = handle.accessor.get(ISessionContext).id;
    const subs = new DisposableStore();
    subs.add(agentSvc.onDidCreateAgent(e => this._onDidCreateAgent.fire({ ...e, sessionId })));
    handle.onDidDispose(() => subs.dispose());                // session 关闭自动解订阅
  }
}

registerSingleton(IAgentLifecycleAggregator, AgentLifecycleAggregator, InstantiationType.Eager);
```

aggregator 默认 `Eager`：核心价值是“全程不漏”，ctor 必须真的轻量（只做 wire 订阅，零 IO）。`Delayed` 会错过首次 `.get()` 之前的所有事件。

Pattern A 与 Pattern B 不冲突：它们订阅同一份事件源（manager typed event）。manager 内部 fire 顺序保证 typed event 先于 `eventBus.publish`，所以同进程 Pattern B 订阅者永远先于 Pattern A 的 wire 订阅者看到事件，状态不滞后。

反模式（禁止）：

```ts
class MyCoreService {
  constructor(@IAgentLifecycleService private readonly agents: IAgentLifecycleService) {}
  //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 编译/解析失败：Core 看不见 Session scope service
}
```

## 派生交互映射

| 用户/上层交互 | 对应机制 |
|---|---|
| 进程启动 | Core scope build；`registerSingleton` / `registerScopedService(Core, ...)` 生效 |
| 打开 session | `ISessionLifecycleService.create` → `SessionScopeBuilder.build` → `ISessionContext` 注入 |
| 创建 agent | `IAgentLifecycleService.create` → `AgentScopeBuilder.build` → `IAgentContext` 注入 + manager attach `IAgentStatus` |
| 开始一轮 turn | `ITurnService.start` → `TurnScopeBuilder.build` → `ITurnContext` 注入 |
| 执行一次工具调用 | `IToolCallScheduler` → `ToolCallScopeBuilder.build` → `IToolCallContext` 注入 |
| 工具调用结束 | `toolCallScope.dispose()` → `onDidExecuteTool` fire |
| turn 结束 / 取消 | `turnScope.dispose()` → `ITurnService.onDidFinishTurn` / `onDidCancelTurn` fire + `eventBus.publish` |
| agent dispose | `IAgentLifecycleService.dispose` → `handle.dispose` → `onDidDisposeAgent` fire |
| session close | `ISessionLifecycleService.close` → 串行 dispose agents → `sessionScope.dispose` → `onDidClose` fire |
| 注册 builtin service | `registerScopedService(scope, id, ctor, type)` 写 `ScopeRegistry` |
| plugin 覆盖 service | `registerScopedService(scope, id, ctor, type, { replace: true })` 静默覆盖 |
| Core 聚合 child 事件 | Core scope typed aggregator（Eager）通过 `handle.accessor.get(manager)` attach |
| 列所有 active agent | `IAgentLifecycleService.list()`（manager 持 `Map<id, IScopeHandle>`） |

## 依赖方向与边界

### 方向总览

```text
Core Scope
  ILogService / IEventService / IChatProviderService / ... (process-wide)
  ISessionLifecycleService  ── manager of Session ──► Session Scope
                                                         IAgentLifecycleService ── manager of Agent ──► Agent Scope
                                                                                                          ITurnService ── manager of Turn ──► Turn Scope
                                                                                                                                                IToolCallScheduler ── manager of ToolCall ──► ToolCall Scope
```

下行：DI 沿 parent 链解析；父 scope 调 `childHandle.dispose()` 触发生命周期。

上行：child scope 发本地 typed event（不带 id）；父 scope 的 manager 通过 `child.accessor.get(...)` 订阅并 re-emit 成集合视图事件（带 id）；`IEventService.publish(...)` 是 wire 的尾节点。

### 禁止的写法

```text
// 禁止 1：Core scope service 内部持 Map<agentId, State>
class GoalService { private readonly state = new Map<string, GoalState>(); }   // 应该用 child container

// 禁止 2：业务方法带 scope id（应通过 ctor 注入 IXxxContext）
goalService.create(agentId, spec);                                              // 应该 goalService.create(spec)

// 禁止 3：child 反向调用 manager 写方法
class TurnService {
  constructor(@IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService) {}
  async start() { this.lifecycle.reportStatusChange(this.ctx.parentId, 'running'); }  // 反向写穿透
}

// 禁止 4：Core 直接 inject child-scope service
class MyCoreService {
  constructor(@IAgentLifecycleService private readonly agents: IAgentLifecycleService) {}  // 解析失败
}

// 禁止 5：ctor 做 IO
constructor() { this.config = fs.readFileSync(...); }                           // 重活推到 init()/首次调用

// 禁止 6：onDidDispose listener 访问 child 内部 service（数据已没）
handle.onDidDispose(() => handle.accessor.get(IGoalService)...);                // 句柄已 dispose
```

### `Map<id, IScopeHandle>` 是唯一允许的 map

Core scope service **禁止** 持 `Map<agentId, State>`。但 parent scope 的 manager **允许** 持 `Map<id, IScopeHandle>`——它的 key 是 child scope identity，不是业务状态切片：

```ts
class AgentLifecycleService {
  private readonly active = new Map<string, { handle: IAgentScopeHandle; childSubs: DisposableStore }>();
}
```

### 跨 scope 查询

| 查询类型 | 解 |
|---|---|
| 当前 scope 内 service 调用 | DI 注入 |
| 父 scope service 调用 | DI 注入（child 沿父链找） |
| 子 scope 查询（“列所有 active agent”） | Parent scope 的 manager 持 `Map<id, IScopeHandle>` |
| 真·跨 scope 聚合（“全局 usage”） | 拆两个 Service：Core scope 一份 `IUsageHistoryService` + Session/Agent scope 一份 `ISessionUsageView` / `UsageView`；上层同时调两边 |

### 不变量总表（hard rules）

1. **DI scope = child InstantiationService**——沿 VSCode platform-services 模式。
2. **scope identity 走 context service**——`IAgentContext` / `ISessionContext` / `ITurnContext` / `IToolCallContext`；方法不带 id 参数。
3. **service 全部 SyncDescriptor + lazy**——ctor 不做 IO。
4. **scope handle `dispose()` 与 manager `onDid*` event 同步配对**——`try { await dispose() } finally { fire onDid*; eventBus.publish(...) }`。
5. **manager service 住父 scope**——上行事件单一发布点。
6. **typed event 不直接到 wire**——`IEventService.publish` 是 wire 尾节点；中间 typed event 只跨同进程 service。
7. **subscriber lifetime-scoped**——订阅 disposable 挂在订阅方 scope 上，自动随之析构，无 dangling。
8. **跨 scope 数据不共享 Service**——拆两个 Service（Core + child scope）。
9. **`registerScopedService` 是唯一注册 API**——Pattern 1 only；重复注册 last-write-wins + warn；显式 replace 用 `{ replace: true }` 静默覆盖。
10. **Builder pipeline 预留 step 3 / 4**——未来 Pattern 2 / 3 增量加，不破坏 Pattern 1。
11. **Core service 订阅子 scope 事件走 aggregator**——禁止 Core inject child-scope service；推荐 typed aggregator + `InstantiationType.Eager`。
12. **manager 通过 `child.accessor.get(...)` 主动 attach 订阅**——child scope 内 service **永远不反向调** manager 的写方法；child 发本地事件（不带 id），manager 在订阅 callback 里 re-emit 成集合视图事件（带 id）。
13. **per-scope event source 优先 derived**——能从已有事件派生的状态（如 `IAgentStatus` 从 `ITurnService.activeCount` 派生）不允许暴露 `setStatus` 写 API。
14. **方法接收 id 参数当且仅当**：(a) 它是 manager service，参数指向它管的下层 scope（`lifecycle.create` / `dispose`）；或 (b) 它住父 scope，参数指向本 scope 内的 children 之一（如 session 内多 agent 路由）；或 (c) 它是 wire RPC 契约（跨进程必须显式携带）；或 (d) 它是无状态的 Core scope facade（无 context 注入可拿）。其它情况下方法**不应**带 scope id——通过 ctor 注入 `IXxxContext` 拿身份。

## 决策记录

- **DR1：用 child container 而不是 `Map<agentId, State>`。** 后者在三处败：(a) API 噪声（处处带 id）；(b) 隔离失效（拿错 id 编译器不查，靠 runtime assertion 兜底）；(c) dispose boilerplate（每个 service 自己 `dispose(agentId)` + listen `onWillDisposeAgent`）。child container 让 ctor 注入 context、方法无 id、dispose 统一调度。

- **DR2：manager service 住父 scope。** 下行生命周期已由 DI 解决；上行通知需要一个单一发布点。manager 在父 scope 能 (a) 创建 / 持 child scope handle（`Map<id, IScopeHandle>`）；(b) 通过 `child.accessor.get(...)` 主动 attach child 事件源；(c) 在 child dispose 完成的 `finally` 路径里 emit onDid\*。让 manager 住父 scope 而不是 child scope，避免 child dispose 后事件无人发。

- **DR3：child 永不反向调 manager 写方法。** 在 manager 上暴露写 API 会让任何能拿到 manager 的代码改任意 child 状态，破坏 scope 隔离；每次调用还要穿 id，回退到 DR1 想根除的 id 透传模式；状态写得分散，多处忘 set 就漏。改为 child 发本地 typed event + manager 主动 attach re-emit。

- **DR4：方法签名不带 scope id。** 身份通过 ctor 注入 `IXxxContext` 拿。例外见不变量 14：manager 指向下层 scope 的 create/dispose、父 scope 内多 child 路由、wire RPC、无状态 Core facade。

- **DR5：`registerScopedService` 是唯一注册 API（Pattern 1 only）。** 仿 VSCode `registerSingleton`。`registerScopedService(Core, ...)` 是其别名，保留以让 5 个 scope 用法一致。Pattern 2（build hook）/ Pattern 3（interceptor）本版不实现，但 builder pipeline 的 step 3 / 4 已预留，未来增量加不破坏 Pattern 1 调用方。

- **DR6：重复注册 last-write-wins + warn；`{ replace: true }` 静默。** 默认重复注册打 warn（让人知道发生了覆盖）但仍覆盖（仿 VSCode）。plugin 覆盖 builtin 用 `{ replace: true }` 显式声明意图，registry 静默。多 plugin 互相覆盖同一 service 不推荐（结果可能因 bundler 不同而变）。

- **DR7：注册必须在第一次 `ScopeBuilder.build()` 之前。** 注册是 import 期 side-effect。build 之后注册 warn + 忽略，避免构建到一半的 scope 拿到不一致的 descriptor。上层包的 entry module 在程序启动期被 import 即可保证。

- **DR8：ctor 不做 IO。** scope build 链可能创建几十个 service；任何 ctor 阻塞都会拖慢 agent 创建延迟，且测试时 mock fake collection 不能跑真 IO。ctor 只允许同步 wiring（订阅 typed event、`accessor.get` 拿依赖不调耗时方法）；重活推到首次调用或 `init()`。

- **DR9：`onWillDispose` 与 `onDidDispose` 语义分开。** `onWillDispose` 在数据还在时触发（manager `await` 全部 listener，抓 snapshot / final flush）；`onDidDispose` 在数据已没时触发（subscriber 只更新自己状态，不允许访问 child 内部 service）。IDisposable 释放本 service 自己的资源（同步 / 简单 await，DI 自动调）；manager event 承载跨 service 协同动作（多 listener 并发 await，manager 显式 fire）。两者协同，不互替。

- **DR10：context 字段归一化为 `id` / `parentId` / `abortSignal` / `executionScope`。** 来源文档（`2026.06.22-Scope-Mechanism.md` §3）用 `sessionId` / `agentId` / `turnId` / `toolCallId` + `signal` 按 scope 命名。本文归一化为 `id` / `parentId`，因为：(a) 跨 scope 处理代码（manager、aggregator、builder）可以泛型化；(b) `parentId` 显式表达嵌套关系；(c) 减少 per-scope 命名发散。`signal` 改名 `abortSignal` 以与 Web `AbortSignal` 术语一致。`executionScope` 是 Kaos 域的执行环境快照（cwd / env），Turn / ToolCall 必需，Session / Agent 携带以向下派生。

- **DR11：5 个 scope（含 ToolCall），不再新增。** 按“独立创建/释放时机 + 多实例并存 + 释放时需级联清理”三条公式，Core / Session / Agent / Turn / ToolCall 是当前需要的全部 scope。User / Project 是 Core 的持久化子集；Background-task 是 Agent 的延迟释放变种；Subagent 是 Agent 的另一实例 + 所有权关系。新增 scope 需三条公式都满足。

- **DR12：跨 scope 数据不共享 Service。** 一个 Service 不能同时存在于两个 scope。“既需要 Core 聚合又需要子 scope 视图”拆两个独立 Service（如 `IUsageHistoryService` Core + `UsageView` Agent），由上层同时调两边。这让 dispose 语义清晰（dispose view 不释放底层）且避免 scope 间状态泄漏。
