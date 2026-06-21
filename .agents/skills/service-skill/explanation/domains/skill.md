# Skill Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的 skill 激活 / 加载流](#统一的-skill-激活--加载流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，**skill** 是一个 domain，承载四类相邻但职责不同的关注点：

- **registry / truth（注册表 / 真相）**：某个 session 当前可见的 skill 定义集合——`SessionSkillRegistry` 维护 `byName` / `byPluginAndName` / `roots` / `skipped`，负责从磁盘发现（`loadRoots`）、注册内置 skill（`registerBuiltinSkill`）、按名查找（`getSkill`）、渲染 skill prompt（`renderSkillPrompt`）、列出可见 skill（`listSkills`）。它是 skill aggregate 的**真相与发现层**，不是 daemon facade。
- **query（描述符查询）**：面向 daemon / SDK 的**只读 skill 描述符查询**——`ISkillService.list(sessionId)`，把内部的 `SkillSummary` 适配成协议的 `SkillDescriptor`（`toProtocolSkill`）。它回答“这个 session 有哪些 skill 可用”。它**没有任何写入入口**。
- **command（激活）**：面向 daemon / SDK 的**激活命令**——`ISkillService.activate(sessionId, skillName, args)`，等价于在 TUI 里输入 `/<skill> <args>`。它在 session 的 main agent 上启动一个 turn、发出 `skill.activated` 事件、记录 telemetry。它是 skill aggregate 对外的**唯一写入入口**。
- **runtime loading（加载）**：把 skill 定义**加载进 agent 进程**——`loadSkills()` 在 session 启动时解析 skill roots（project / user / extra / builtin）、调用 `registry.loadRoots(roots)` 发现并注册、注册内置 skill。它是**每次 session 启动重新发现**的运行时动作，不是持久化真相。M5.1 将把它移入一个 `SkillRuntime`，订阅 `onSessionDidStart` 生命周期钩子。

**这四类关注点不需要合并、也不需要进一步拆分。** 边界当前就是干净的：

- query（`list`）只做**只读描述符查询 + 协议形状适配**，不写 registry、不触发激活、不持有运行时状态。
- command（`activate`）只做**激活命令**（启动 turn + 事件 + telemetry），不重新实现 skill 发现、不直接读 registry 真相——它经 CoreAPI 到达 in-process 的 `SkillManager.activate`，后者才查 registry、渲染 prompt、装配 turn。
- runtime loading（`loadSkills`）只做**启动期发现与注册**，不暴露 daemon 形状、不处理激活命令。
- registry（`SessionSkillRegistry`）只做**真相 + 发现 + prompt 渲染**，是下层被 facade / runtime 消费的 contract，自身不暴露在 SDK 边界。

**关系一句话：registry 拥有 skill 定义的真相与发现；query 经 `ISkillService.list` 把描述符暴露给 daemon / SDK；command 经 `ISkillService.activate`（落到 in-process `SkillManager.activate`）触发激活；runtime loading 在 session 启动时把定义加载进 registry，M5.1 改由 `SkillRuntime` 订阅 `onSessionDidStart` 完成。**

接口定义见 `services/skill/skill.ts` 的 `ISkillService`（daemon/SDK query + command facade）、`agent/skill/index.ts` 的 `SkillManager` / `IAgentSkillService`（in-process 激活实现）、`skill/registry.ts` 的 `SessionSkillRegistry` / `ISkillRegistryService`（真相 + 发现层）、`session/index.ts` 的 `loadSkills`（runtime loading）。本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. “发现真相”“查询描述符”“激活命令”“启动期加载”是四个不同的关注点

skill 这个 domain 同时涉及四件事，它们的生命周期、真相、副作用都不同：

- **发现真相（registry）**：给定一个 session，从磁盘（project / user / extra / builtin）发现并持有一份 skill 定义集合，支持按名查找、按 plugin 查找、prompt 渲染、列表。真相在磁盘 + 内存索引，随 session 重建。
- **描述符查询（query）**：把当前 registry 的可见 skill 列表**适配成协议形状**返回给 daemon / SDK。只读、可重入、无副作用，scope 固定为单个 session。
- **激活命令（command）**：在 session 的 main agent 上**触发一次激活**——校验 skill 可被用户激活、渲染 prompt、启动 turn、发出事件、记录 telemetry。有副作用（改变 agent 状态、产生事件流）。
- **启动期加载（runtime loading）**：session 启动时**重新发现** skill 并填入 registry，是一次性的运行时动作；重启后由同一路径重建，不写回任何持久化真相。

因此：registry 是下层 truth；query 与 command 是 daemon / SDK 边界的 facade；runtime loading 是把 truth 装入 registry 的启动动作。

### 2. 命令 / 查询 / 运行时状态分开（按需要引入）

按 service-skill 的角色表，本 domain 实际用到三类：

| 类型 | 关注 | 归属 |
|---|---|---|
| Query | 单 scope skill 描述符列表：`list`（协议形状适配） | `ISkillService.list`（`SkillService`） |
| Command | skill 激活：`activate`（启动 turn + 事件 + telemetry） | `ISkillService.activate`（`SkillService`）→ in-process `SkillManager.activate` |
| Runtime loading | session 启动期 skill 发现与注册 | `loadSkills`（M5.1 移入 `SkillRuntime`，订阅 `onSessionDidStart`） |
| Registry / truth | skill 定义集合 + 发现 + prompt 渲染 | `SessionSkillRegistry`（`ISkillRegistryService`） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md) 的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才引入”。

- **query 已经是单方法 facade。** `ISkillService.list` 只有一个读方法，scope 固定为单 session，无分页 / search / count——它**就是** skill aggregate 在 SDK 边界的 query 角色。再拆一个 `ISkillQueryService` 不会引入新的契约，只是把同一个方法换个接口名。
- **command 已经是单方法 facade。** `ISkillService.activate` 只有一个写方法，没有 create / update / archive / fork 等生命周期族——它**就是** skill aggregate 在 SDK 边界的 command 入口。再拆一个 `ISkillCommandService` 同样是同名复制。
- **runtime loading 不是查询模型，也不是命令。** `loadSkills` 是 session 启动期的发现动作，没有 per-id 状态读取、没有 list / search / count、不暴露 SDK 形状；它最接近 [`runtime-service.md`](../../reference/patterns/runtime-service.md) 描述的“由进程内对象 / 事件流推导的活状态”的**填充动作**，但目前是 Session 构造器里的一段 fire-and-forget，M5.1 才升级为正式 `SkillRuntime` 角色。

### 3. registry 不表达 SDK 形状，facade 不持有发现逻辑

边界保持干净：

- registry（`SessionSkillRegistry`）只持有**定义真相 + 发现 + prompt 渲染**：`byName` / `byPluginAndName` / `roots` / `skipped`、`discoverSkills`、`renderSkillPrompt`。它不知道 daemon 的 `SkillDescriptor` 形状、不做 snake_case / camelCase 适配、不发出 `skill.activated` 事件。
- facade（`ISkillService`）只持有**SDK 适配 + session 解析**：`toProtocolSkill` 的形状翻译、`_requireLoadedSession` 的 session 存在性校验、`coreApi()` 的 in-process 派发。它不直接读 registry 的 `byName`，不重新实现 skill 发现。

这条边界是“是否需要拆分 / 合并”的唯一硬指标：只要 registry 不混入 SDK 形状、facade 不混入发现逻辑，两类关注点就是清晰的。

### 4. 激活是 command，落点是 in-process `SkillManager.activate`

`ISkillService.activate` 是 daemon / SDK 的**命令 facade**——它的实现非常薄：校验 session → 经 `coreApi().activateSkill(...)` 派发。真正的激活副作用发生在 in-process 的 agent 侧：

- `KimiCore.activateSkill` → `sessionApi.activateSkill` → `rpc-controller` 的 `activateSkill` handler → `this.host.skills.activate(payload)`（即 `SkillManager.activate`）。
- `SkillManager.activate` 查 registry（`getSkill`）、校验类型可用户激活（`isUserActivatableSkillType`）、渲染 prompt（`renderSkillPrompt` + `renderUserSlashSkillPrompt`）、调 `recordActivation`。
- `recordActivation` 发出 `skill.activated` 事件、记录 `skill_invoked` / `flow_invoked` telemetry，并把渲染后的 prompt 通过 `agent.turn.prompt(input, origin)` 推入 turn（origin = `skill_activation`，trigger = `user-slash`）。

所以 command 角色横跨两层：`ISkillService.activate` 是对外 facade，`SkillManager.activate` 是 in-process 实现。二者经 CoreAPI 单向连接，facade 不重新实现激活逻辑。

### 5. 启动期加载是 runtime，不是持久化动作

skill 定义不写回任何 aggregate 真相——每次 session 启动都由 `loadSkills` 重新发现：

- `loadSkills` 解析 skill roots（user home / brand home / workDir / explicit / extra / plugin / builtin），调 `registry.loadRoots(roots)`（内部 `discoverSkills`），再 `registerBuiltinSkills` 注入内置 skill。
- 它作为 `this.skillsReady` 这个 fire-and-forget promise 挂在 Session 构造器上；`listSkills` / `flushMetadata` / 需要 skill 的路径会先 `await this.skillsReady`。
- 重启后由同一路径重建 registry，没有任何“加载状态”需要持久化。

因此 runtime loading 是一次性的、可重建的启动动作。当前它直接住在 Session 构造器里；M5.1 将把它抽到 `SkillRuntime`，由 `SkillRuntime` 订阅 `onSessionDidStart` 触发——这样 skill 加载与其它 session 启动期副作用（如 MCP 连接）共享同一生命周期编排，而不是各自挂在构造器上。

### 6. Service 层 facade 暴露 query + command，transport 层只做形状适配

- **query**：registry 的描述符收集（`listSkills` → `summarizeSkill`）在 agent 进程内完成；SDK 边界 `ISkillService.list` 只做 `SkillSummary` → `SkillDescriptor` 的形状翻译（`toProtocolSkill`）；REST 路由只负责 session 校验与错误码映射（`SessionNotFoundError` → 40401），不重新解释 skill 语义。
- **command**：激活副作用在 agent 进程内的 `SkillManager.activate` 完成；SDK 边界 `ISkillService.activate` 只做 session 解析 + in-process 派发 + 错误码翻译（`SKILL_NOT_FOUND` / `SKILL_NAME_EMPTY` → `SkillNotFoundError` → 40415，`SKILL_TYPE_UNSUPPORTED` → `SkillNotActivatableError` → 40912）。
- **runtime loading**：`loadSkills` 在 Session 启动期完成，不暴露到 daemon / SDK 边界；daemon 只在 `list` / `activate` 时间接地 `await skillsReady`。

## Service 拆分概览

| Service / 角色 | 一句话职责 | 角色 |
|---|---|---|
| `ISkillService` | daemon/SDK skill facade：`list`（query，描述符查询）+ `activate`（command，激活） | query + command（facade） |
| `SkillService` | `ISkillService` 实现：session 解析 + `toProtocolSkill` 适配 + `coreApi()` in-process 派发 + 错误码翻译 | query + command（impl） |
| `IAgentSkillService` / `AgentSkillService` | in-process 激活实现：`activate`（查 registry / 渲染 prompt / 启动 turn）+ `recordActivation`（事件 + telemetry） | command（runtime impl） |
| `SkillManager` | `AgentSkillService` 的基类，承载激活副作用 | command（runtime impl） |
| `ISkillRegistryService` / `SkillRegistryService` | skill 定义真相 + 发现 + prompt 渲染 | registry / truth |
| `SessionSkillRegistry` | registry 实现：`byName` / `byPluginAndName` / `loadRoots` / `renderSkillPrompt` / `listSkills` | registry / truth（impl） |
| `loadSkills`（M5.1 → `SkillRuntime`） | session 启动期 skill 发现与注册 | runtime loading |

> 只有这些角色。**不引入 `ISkillQueryService` / `SkillQueryService`**——`ISkillService.list` 已经是单方法、单 scope、无分页的 query facade，再拆一层只是同名复制。
> **不引入 `ISkillCommandService` / `SkillCommandService`**——`ISkillService.activate` 已经是单方法 command facade，没有 create / update / archive / fork 族，再拆一层同样只是同名复制。
> **runtime loading 当前住在 Session 构造器里**（`session/index.ts:325` 的 `loadSkills` / `:189` 的 `skillsReady`），M5.1 才升级为正式 `SkillRuntime` 角色；本阶段只记录方向，不做迁移。
> 共享类型（`SkillDescriptor` / `SkillSummary` / `SkillDefinition` / `SkillRegistry` / `SkillActivationOrigin` 等）见 `@moonshot-ai/protocol`、`rpc/core-api.ts`、`skill/types.ts`、`agent/skill/types.ts`、`agent/context/`。

模式参考：

- query 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md) 的**只读 list 语义**：`ISkillService.list` 是这个 aggregate 的读模型入口；但 scope 固定为单个 session、无 `Query` 类型、无分页 / search / count，所以**不套用**完整的 `BaseQuery` + scope 便捷方法骨架。`ISkillService.list` 已把 query 角色的契约（单 scope list + 协议形状适配）一次性实现完，无需再拆。
- command 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md) 的**唯一写入入口**语义：`ISkillService.activate` 是这个 aggregate 对 daemon / SDK 的唯一命令入口；但它没有 create / update / archive / fork 等生命周期族，所以**不套用**完整的 `ICommandService` 骨架。激活本身不是“创建 / 修改 aggregate”，而是“在 agent 上触发一个 turn”——更接近一个动作命令。
- runtime loading 侧最接近 [`runtime-service.md`](../../reference/patterns/runtime-service.md) 描述的“由进程内对象 / 事件流推导的活状态”的**填充动作**：skill registry 的内容由 session 启动期的发现事件流填充，重启后重建，不写回真相。M5.1 把它升级为正式 `SkillRuntime` 后，会补全 `onSessionDidStart` 订阅 +（如需）per-id 状态读取。

## 统一的 skill 激活 / 加载流

### 启动期加载流（runtime loading）

```text
Session constructor
  └─ this.skillsReady = this.loadSkills()            // fire-and-forget，挂到 Session
       ├─ resolveSkillRoots({ paths, explicitDirs, extraDirs, pluginSkillRoots, ... })
       ├─ this.skills.loadRoots(roots)               // registry：discoverSkills → byName / byPluginAndName
       └─ registerBuiltinSkills(this.skills)         // 注入 builtin skill
  └─ new SessionHost({ session, scope, skillsReady })
  └─ void this.loadMcpServers()                      // 同类启动期副作用（MCP）
```

要点：

- `loadSkills` 是**唯一的 skill 发现 owner**：所有 skill 定义经它进入 registry；facade 不自己发现 skill。
- registry 是**唯一的定义真相**：`byName` / `byPluginAndName` / `roots` / `skipped` 都在 `SessionSkillRegistry`；facade / runtime 都消费它，不重复持有。
- `skillsReady` 是加载完成的**同步点**：`listSkills` / `flushMetadata` 等路径先 `await this.skillsReady`，保证 registry 已填充。

### 激活流（command）

```text
skillService.activate(sid, skillName, args?)          // ISkillService：command facade
  ├─ _requireLoadedSession(sid)                       //   确认 session 存在并加载（→ SessionNotFoundError / 40401）
  └─ coreApi().activateSkill({sid, agentId:'main', name, args})
       └─ KimiCore.activateSkill                      //   in-process 派发
            └─ sessionApi.activateSkill
                 └─ rpc-controller.activateSkill      //   agent 侧 handler
                      └─ host.skills.activate(payload) //   SkillManager.activate
                           ├─ registry.getSkill(name)              // 查真相（→ SKILL_NOT_FOUND）
                           ├─ isUserActivatableSkillType(type)     // 校验可激活（→ SKILL_TYPE_UNSUPPORTED）
                           ├─ registry.renderSkillPrompt(...)      // 渲染 skill prompt
                           └─ recordActivation(origin, wrapped)
                                ├─ emitEvent({ type:'skill.activated', ... })   // 事件
                                ├─ telemetry.track('skill_invoked' | 'flow_invoked')  // telemetry
                                └─ agent.turn.prompt(input, origin)             // 启动 turn
```

要点：

- `ISkillService.activate` 是**唯一的激活 facade**：所有 daemon / SDK 的激活都经它；它只做 session 解析 + 派发 + 错误码翻译。
- `SkillManager.activate` 是**唯一的激活副作用 owner**：查 registry / 渲染 / 事件 / telemetry / 启动 turn 都在它；facade 不重新实现这些。
- facade 对 in-process 的引用是**单向 CoreAPI**：`services/skill/` 不直接 import `agent/skill/`，二者经 `coreApi().activateSkill` 连接。

> `coreApi().activateSkill` 是 command facade 消费 command runtime 的**派发原语**，不是 `ISkillService` 暴露的方法。facade 把它作为激活的实现细节，对外只暴露 `activate(sid, name, args)` 命令语义。

## 关键场景

### 场景 A：列出 session 的可用 skill（纯 query）

```ts
skillService.list(sid);
```

内部解析：`_requireLoadedSession(sid)` 确认 session 存在并加载；`coreApi().listSkills({sid})` 返回 `SkillSummary[]`（内部 `await skillsReady` 后 `registry.listSkills().map(summarizeSkill)`）；`toProtocolSkill` 把 camelCase `SkillSummary` 映射成 snake_case `SkillDescriptor`。无 registry 写入、无激活。

### 场景 B：激活一个 prompt 类型 skill

```ts
skillService.activate(sid, 'review', 'src/foo.ts');
```

内部解析：facade 派发到 in-process `SkillManager.activate`；registry 命中 `review`、类型可用户激活；`renderSkillPrompt` 把 `'src/foo.ts'` 填入 skill 模板参数；`recordActivation` 发出 `skill.activated` 事件 + `skill_invoked` telemetry，并把包装后的 prompt 经 `agent.turn.prompt` 启动一个 turn（trigger `user-slash`）。

### 场景 C：激活不存在的 skill

```ts
skillService.activate(sid, 'nope');
```

内部解析：in-process `registry.getSkill('nope')` 返回 `undefined` → `KimiError(SKILL_NOT_FOUND)`；facade 在 `activate` 的 `catch` 里把它翻译成 `SkillNotFoundError`（→ 40415）。registry 与 agent 状态不变。

### 场景 D：激活不可用户激活的 skill（如 `reference` 类型）

```ts
skillService.activate(sid, 'some-reference-skill');
```

内部解析：in-process `isUserActivatableSkillType(type)` 返回 `false` → `KimiError(SKILL_TYPE_UNSUPPORTED)`；facade 翻译成 `SkillNotActivatableError`（→ 40912）。无 turn 启动。

### 场景 E：session 启动期加载 skill（runtime loading）

```text
new Session(...)
  → this.skillsReady = this.loadSkills()
       → resolveSkillRoots({ workDir, userHomeDir, brandHomeDir, ... })
       → registry.loadRoots(roots)        // discoverSkills 扫描 project / user / extra / builtin
       → registerBuiltinSkills(registry)  // 注入 builtin
  → skillsReady.then(() => host.refreshAgentBuiltinTools())
```

内部解析：skill 定义经 `discoverSkills` 进入 registry 的 `byName` / `byPluginAndName`；`skillsReady` 是加载完成的同步点；daemon 的首次 `list` / `activate` 会隐式 `await skillsReady`。M5.1 这一段将由 `SkillRuntime.onSessionDidStart` 触发，而不是直接挂在构造器上。

### 场景 F：daemon 重启后，session 在磁盘但不在活跃 map

```text
skillService.list(sid) / activate(sid, name)
  → _requireLoadedSession(sid)
       → coreApi().listSessions({})        // 确认 session 存在
       → coreApi().resumeSession({sid})    // 幂等加载进活跃 map
  → 后续 listSkills / activateSkill 不会 miss
```

内部解析：facade 在每次 `list` / `activate` 前先保证 session 已加载，避免 daemon 重启后 SessionAPI 派发到不存在的活跃 session。这与 `PromptService.submit` / `SessionService.undo` 是同一模式。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 |
|---|---|---|
| 列出 session 可用 skill | `skillService.list(sid)` | query（skill facade） |
| 激活 skill（等价 `/<skill> <args>`） | `skillService.activate(sid, name, args?)` | command（skill facade） |
| SkillSummary → 协议 SkillDescriptor 形状翻译 | `toProtocolSkill(info)` | query（skill，纯函数） |
| in-process 激活副作用 | `SkillManager.activate(payload)` | command（runtime impl） |
| 记录激活（事件 + telemetry + 启动 turn） | `SkillManager.recordActivation(origin, input?)` | command（runtime impl） |
| 渲染 skill prompt（参数展开） | `SessionSkillRegistry.renderSkillPrompt(skill, args)` | registry / truth |
| 包装用户 slash skill prompt | `renderUserSlashSkillPrompt(...)`（`agent/skill/prompt.ts`） | command（runtime impl，纯函数） |
| 按名查找 skill | `registry.getSkill(name)` / `getPluginSkill(pluginId, name)` | registry / truth |
| 列出可见 skill（内部） | `registry.listSkills()` / `listInvocableSkills()` | registry / truth |
| 发现 skill（扫描 roots） | `registry.loadRoots(roots)` → `discoverSkills` | registry / truth |
| 注册内置 skill | `registry.registerBuiltinSkill(skill)` / `registerBuiltinSkills(registry)` | registry / truth |
| session 启动期加载 skill | `Session.loadSkills()`（M5.1 → `SkillRuntime.onSessionDidStart`） | runtime loading |
| 校验 skill 可用户激活 | `isUserActivatableSkillType(type)`（`skill/types.ts`） | registry / truth（纯函数） |
| facade 派发激活（CoreAPI） | `skillService.activate` 内 `coreApi().activateSkill(...)` | command facade 消费 runtime（单向） |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service (daemon / SDK facade)
  ISkillService                  (query + command — list 描述符查询 / activate 激活命令，SkillSummary → SkillDescriptor)

Runtime (in-process)
  SkillManager / IAgentSkillService   (command impl — 查 registry / 渲染 prompt / 启动 turn / 事件 / telemetry)
  SessionSkillRegistry / ISkillRegistryService  (registry / truth — 定义集合 + 发现 + prompt 渲染)
  loadSkills (M5.1 → SkillRuntime) (runtime loading — session 启动期发现与注册，订阅 onSessionDidStart)

Domain / Policy
  SkillDefinition                (skill 定义：name / description / metadata / content / source / plugin)
  SkillRegistry                  (registry 抽象接口：getSkill / listInvocableSkills / renderSkillPrompt / getModelSkillListing)
  SkillActivationOrigin          (skill_activation 事件来源：trigger user-slash / 类型 / 参数)

Infrastructure
  Skill discovery                (scanner.discoverSkills / parser.expandSkillParameters：磁盘扫描 + 模板参数展开)
  SDK adapters                   (toProtocolSkill：内部 SkillSummary → 协议 SkillDescriptor)
  CoreAPI handle                 (skill facade 经 ICoreRuntime 取 in-process listSkills / activateSkill)
  Lifecycle hooks                (onSessionDidStart：M5.1 SkillRuntime 的订阅入口)
```

依赖关系：

```text
ISkillService.activate  → CoreAPI.activateSkill          (command facade → in-process runtime，单向派发)
ISkillService.list      → CoreAPI.listSkills             (query facade → in-process registry 只读)
ISkillService           → toProtocolSkill                (协议形状适配)
SkillManager.activate   → SkillRegistry.getSkill / renderSkillPrompt  (command impl 读 registry 真相)
SkillManager.recordActivation → Agent.emitEvent / telemetry / turn.prompt  (事件 + telemetry + 启动 turn)
SessionSkillRegistry    → discoverSkills / parser        (发现 + 参数展开)
SessionSkillRegistry    → SkillRegistry (type only)      (实现 agent/skill/types 的接口，仅类型导入)
loadSkills              → resolveSkillRoots / loadRoots / registerBuiltinSkills  (启动期发现)
loadSkills (M5.1)       → ILifecycleService.onSessionDidStart  (runtime 订阅启动钩子)
```

禁止的边界：

```text
ISkillService           → SkillManager.activate / registry.loadRoots / discoverSkills  (facade 不直接触达 runtime impl / 发现逻辑；只能经 CoreAPI)
SessionSkillRegistry    → toProtocolSkill / SkillDescriptor / SkillSummary             (registry 不表达 SDK 形状)
SkillManager            → ISkillService / services/skill                               (runtime impl 不回调 facade)
SessionSkillRegistry    → services/**                                                  (registry 不依赖 daemon facade)
loadSkills              → ISkillService                                                (runtime loading 不依赖 facade；只填 registry)
```

关键不变量：

- registry 侧不持有 SDK 形状（无 `SkillDescriptor` / snake_case 适配）；facade 侧不持有发现逻辑（无 `discoverSkills` / `loadRoots`）。
- skill 定义的真相在 registry（`SessionSkillRegistry.byName`），facade 只在 `list` 时经 CoreAPI 只读 `listSkills`，不自己扫描磁盘。
- facade 对 runtime impl 的引用仅限：经 CoreAPI 的 `activateSkill` / `listSkills`（in-process 派发，去序列化）；`services/skill/` 不直接 import `agent/skill/` 或 `skill/registry.ts` 的实现。
- command 副作用（事件 / telemetry / 启动 turn）集中在 `SkillManager.recordActivation`，REST 路由与 facade 不重新解释激活语义。
- runtime loading 当前是 Session 构造器上的 fire-and-forget；M5.1 改为 `SkillRuntime` 订阅 `onSessionDidStart` 后，仍是单向填 registry，不引入新的跨层依赖。

## 决策记录

- **DR1：skill 是一个 domain，承载四类关注点。** registry / truth（定义集合 + 发现 + prompt 渲染）、query（`list` 描述符查询）、command（`activate` 激活）、runtime loading（启动期加载）同属一个 skill domain；四者关注点不同、真相不同、副作用不同，但共享同一份 registry 真相，不拆成多个 domain。
- **DR2：激活 = command。** `ISkillService.activate(sessionId, skillName, args?)` 是 skill aggregate 对 daemon / SDK 的唯一写入入口；它的副作用（启动 turn、`skill.activated` 事件、`skill_invoked` telemetry）落在 in-process `SkillManager.activate` / `recordActivation`。facade 只做 session 解析 + CoreAPI 派发 + 错误码翻译，不重新实现激活逻辑。
- **DR3：描述符列表 = query（与 command 共用 facade）。** `ISkillService.list(sessionId)` 是只读描述符查询 + `toProtocolSkill` 形状适配；scope 固定为单 session、无分页 / search / count。它不持有运行时状态、不触发激活、不写 registry。
- **DR4：加载 = runtime（M5.1 接入生命周期）。** `loadSkills()` 在 session 启动时重新发现 skill 并填入 registry，是一次性、可重建的运行时动作；当前挂在 Session 构造器的 `skillsReady` 上。M5.1 将把它抽入 `SkillRuntime`，由 `SkillRuntime` 订阅 `onSessionDidStart` 触发，与其它 session 启动期副作用共享同一生命周期编排。本阶段只记录方向，不做迁移。
- **DR5：registry = 真相 / 发现层，不是 service facade。** `SessionSkillRegistry`（`ISkillRegistryService`）拥有 skill 定义集合 + `discoverSkills` 发现 + `renderSkillPrompt` 渲染；它是被 facade / runtime 消费的下层 contract，不暴露在 SDK 边界，不表达 `SkillDescriptor` 形状。
- **DR6：不引入 `SkillQueryService`。** `ISkillService.list` 已经是单方法、单 scope、无分页的 query facade；再拆一个 `ISkillQueryService` 不会引入新契约，只是把同一个方法换个接口名，并被迫复制 `_requireLoadedSession` / `coreApi()` 派发管道。当前 skill aggregate 的 query 角色已经由 `ISkillService.list` 一次性实现完。
- **DR7：不引入 `SkillCommandService`。** `ISkillService.activate` 已经是单方法 command facade，没有 create / update / archive / fork 等生命周期族；再拆一个 `ISkillCommandService` 同样是同名复制 + 管道复制。当前 skill aggregate 的 command 角色已经由 `ISkillService.activate`（facade）+ `SkillManager.activate`（runtime impl）一次性实现完。
- **DR8：`list` 与 `activate` 共用 `ISkillService` 不构成 muddle。** 二者是同一个薄 SDK 适配器上的两个独立方法，实现互不调用（`SkillService.list` 不调 `activate`，反之亦然）——AGENTS.md 的“command / query 角色不互相调用业务方法”针对的是实现耦合，不是接口同址。共用 facade 避免了为两个单方法角色各复制一份 session 解析 + CoreAPI 派发管道。真正的角色分离（query/command facade vs runtime impl vs registry truth）已经按文件 / 层物理分离，没有重叠或渗漏。
- **DR9：当前代码布局已满足边界，无需迁移。** facade 在 `services/skill/`（`ISkillService` / `SkillService` / `toProtocolSkill`，query + command）；command runtime impl 在 `agent/skill/`（`SkillManager` / `IAgentSkillService` / `AgentSkillService`）；registry truth 在 `skill/registry.ts`（`SessionSkillRegistry` / `ISkillRegistryService`）；runtime loading 在 `session/index.ts`（`loadSkills` / `skillsReady`，M5.1 移入 `SkillRuntime`）。依赖方向单向：`services/skill` → CoreAPI → `agent/skill` / `skill/registry`；`agent/skill` → `skill/registry`（接口）+ `agent/context`（origin）；`skill/registry` → `skill/`（scanner/parser/types）+ `agent/skill/types`（仅类型）。三层都没有反向 import `services/skill`，M0.1 fence 干净。本次只出概念定稿，不做代码拆分。
