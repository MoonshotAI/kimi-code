# 权限系统设计（Permission）

本文系统整理 agent-core 权限系统的目标方案，并与 `packages/agent-core`（v1）现状对比。结论先行：

> **权限系统应是一个「可组合、可注册的责任链（微内核）」**：内核只负责按顺序跑链、首个命中赢；具体权限维度（policy）由各自的 Domain Service 通过注册表插入；工具只需在 `resolveExecution` 里声明标准化的资源访问（`accesses`），通用维度集中消费这份元数据。
>
> **链只裁决危险程度**。policy 节点回答的是「这个调用有多危险、用户能否逐次豁免这个判断」——它产出的 `ask`/`deny` 永远可被用户豁免。**Harness 约束不是权限**：运行机制为自身正确性施加的限制（plan 模式禁写、AgentSwarm 批量排他、btw side-question fork 禁工具、goal 预算拒绝）产出的是无 ask 通道、用户无法逐次豁免的硬 deny，它们以 `onBeforeExecuteTool` veto 监听器挂在各自 domain，用 `event.veto(...)` 表态（先例：`goalService.ts` 的预算/过期拒绝）。产物审批（plan review、goal-start review）同样不是权限：由 owning domain 用 cold 的 `event.waitUntil(factory)` 拦截自己的工具、直接驱动共享的 `IAgentToolApprovalService` 审批往返——审批只可能在没有任何监听器 veto 该调用之后才开始。
>
> **不引入 Casbin**——因为这里「难的是决策行为」（续体、副作用、RPC、状态机），不是「匹配 + 标量决策」。

---

## 一、背景与问题定义

权限系统回答一个问题：**对于每一次工具调用，在当前 agent、当前 mode 下，放行 / 拒绝 / 询问用户？**

这个决策有三个特点，决定了它的架构取向：

1. **决策携带行为**。返回 `ask` 不是一个枚举值，而是一条含 RPC 往返、hook、telemetry、状态写入、续体的工作流；返回 `deny` 可能是执行了一段外部 hook 的结果。
2. **策略异质**。有的查工具名集合，有的数同批 AgentSwarm 个数，有的跑 hook，有的检查 plan 状态机——没有统一的 `(sub, obj, act)` 形状。
3. **多 agent × 多 mode × 外部扩展**。不同 agent / mode 需要不同权限，且要允许外部（组织管理员、插件）解耦地贡献规则或行为。

---

## 二、现状（agent-core v1）

代码位于 `packages/agent-core/src/agent/permission/`。

### 2.1 架构：有序责任链 + 首个命中赢

`PermissionManager`（`index.ts`）持有一组 `PermissionPolicy`，决策时顺序遍历，第一个返回非 `undefined` 的 policy 胜出：

```ts
// index.ts evaluatePolicies
for (const policy of this.policies) {
  const result = await policy.evaluate(context);
  if (result !== undefined) return { policyName: policy.name, result };
}
```

每个 policy 是一个实现 `PermissionPolicy` 接口的类，`evaluate(context)` 不适用就返回 `undefined`（传给下一个）。`PermissionPolicyResult` 不是标量，而是可携带续体和副作用的「行为包」：

```ts
// types.ts
type PermissionPolicyResult =
  | { kind: 'approve'; reason?; executionMetadata? }
  | { kind: 'deny';    reason?; message? }
  | { kind: 'ask';     reason?; resolveApproval?; resolveError? };
```

### 2.2 11 个权限维度（19 个 policy）

链目前在 `policies/index.ts#createPermissionDecisionPolicies()` 中**硬编码**，顺序即优先级。19 个 policy 可归并为 11 个权限维度：

| # | 维度 | 对应 policy | 决策看什么 |
|---|---|---|---|
| 1 | 外部钩子否决 | `pre-tool-call-hook` | 用户 `PreToolUse` hook 是否返回 block |
| 2 | 工具批量排他 | `agent-swarm-exclusive-deny`、`swarm-mode-agent-swarm-approve` | 同批工具结构（AgentSwarm 须单独）+ swarm 模式 |
| 3 | 运行模式姿态 | `auto-mode-approve`、`yolo-mode-approve`、`auto-mode-ask-user-question-deny` | `permission.mode` |
| 4 | Plan 模式约束 | `plan-mode-guard-deny`、`plan-mode-tool-approve`、`exit-plan-mode-review-ask` | `planMode.isActive` + plan 文件路径 + review 状态 |
| 5 | Goal 启动审批 | `goal-start-review-ask` | `tool === CreateGoal` 且非 auto |
| 6 | 静态配置规则 | `user-configured-deny/ask/allow` | 用户/项目/turn 配置的 DSL 规则 |
| 7 | 会话批准记忆 | `session-approval-history` | 本会话 "approve for session" 缓存 |
| 8 | 敏感/特殊路径 | `sensitive-file-access-ask`、`git-control-path-access-ask` | 工具访问的文件路径 |
| 9 | 工具内在风险 | `default-tool-approve` | 工具名 ∈ 默认安全集合 |
| 10 | 工作区写信任 | `git-cwd-write-approve` | POSIX + git worktree + cwd 内写 |
| 11 | 兜底 | `fallback-ask` | 无（默认 ask） |

链的顺序是一条**从高到低的安全级联**：外部强制 → 结构性拒绝 → 状态机拒绝 → 静态 deny → mode 放行 → 会话记忆放行 → 静态 ask → 静态 allow → 流程放行 → 敏感路径 ask → 默认放行 → 兜底 ask。

### 2.3 资源访问声明：`resolveExecution` + `accesses`

工具通过 `resolveExecution(input)` 在执行前声明自己访问的资源（`packages/agent-core/src/loop/types.ts`、`tool-access.ts`）：

```ts
interface RunnableToolExecution {
  readonly accesses?: ToolAccesses;        // 资源 + 操作
  readonly matchesRule?: (ruleArgs) => boolean;
  readonly approvalRule: string;
  readonly execute: (ctx) => Promise<ExecutableToolResult>;
}
```

`ToolAccesses` 是 `ToolResourceAccess[]`，目前支持 `file` 与 `all` 两类资源（详见 §5.5）。权限维度（如 `sensitive-file-access-ask`、`git-cwd-write-approve`）读 `context.execution.accesses` 做判断。

### 2.4 优势

- **清晰可审计**：顺序显式，每个 policy 旁有注释解释其位置，安全姿态一目了然。
- **首个命中短路**：大多数调用（如只读工具）在 `default-tool-approve` 即返回，性能好。
- **行为表达力强**：`ask` 可携带 `resolveApproval` 续体、`executionMetadata`、自定义消息和副作用。

### 2.5 痛点

1. **链硬编码**。19 个 policy 在一个函数里 `new`，外部无法贡献。
2. **mode 是 policy 内部的 `if`**。`YoloModeApprove` / `AutoModeApprove` 各自 `if (mode !== 'x') return`，"不同 mode 不同链"只能靠塞更多 self-guard 的 policy。
3. **没有按 agent 区分链的入口**（只有散落的 `agent.type === 'sub'` 判断）。
4. **没有外部扩展点**。唯一的外部介入是 `PreToolUse` hook（占 guard 一个固定槽位）。
5. **bash/write 等通用工具的维度集中在核心**，工具自己只声明 `accesses`，不知道维度存在——这是优点，但也意味着新增维度要改核心。

---

## 三、为什么不是 Casbin

Casbin 的两个卖点（`policy_effect` 和灵活 priority）在当前业务下都落不到实处。

### 3.1 `policy_effect` 用不上

`policy_effect` 解决「多规则命中后如何组合」。但 agent-core 的组合逻辑是**固定的安全级联**，且真正的复杂度在每条 policy 的 `evaluate` 行为里，Casbin 表达式吸收不了。更重要的是：组合顺序是安全相关的、故意写死的姿态，不希望外部改动——外部可调的安全旋钮已通过 `mode` + allow/deny/ask 规则暴露。

### 3.2 灵活 priority 用不上

priority 的痛点是「多模块各自贡献规则时数字撞车」。agent-core 当前没有插件注入点、没有多主体/RBAC，主体固定（agent/用户），不存在撞车问题。Casbin 的 `(sub, obj, act)`、`g()`、domain 等抽象在这里空转。

### 3.3 根本性不匹配：决策不是标量

`enforce()` 的契约是「输入请求 → 输出 effect」。agent-core 的决策是**行为包**：

| policy | 返回 `ask` 后的真实行为 |
|---|---|
| `requestToolApproval` | 触发 hook → 异步 RPC 问用户 → 记 telemetry → 写 records/replay → 可选写会话缓存 → 调续体 |
| `goal-start-review-ask` | 弹菜单 → 根据回答**切换 permission mode** → 放行 |
| `exit-plan-mode-review-ask` | 推进 plan 状态机 → 记多种 telemetry → **合成工具结果**短路执行 |
| `pre-tool-call-hook` | `deny` 是**异步执行外部 hook** 的结果 |

这些续体、副作用、合成结果没有槽位放进 Casbin 的标量 effect。即便让 Casbin 算出 `ask`，外面仍需重写一整套把 `ask` 关联到行为的逻辑——Casbin 降级成枚举生成器。

### 3.4 Casbin 何时才值得

当「难的是匹配语义本身」时——角色继承、domain 隔离、ABAC 表达式、从 DB 加载策略——Casbin 才有用武之地。在此之前不引入。

---

## 四、设计模式定位

权限编排不是一个单一模式，而是分层组合：

| 层 | 模式 | 作用 |
|---|---|---|
| 运行时决策 | **责任链（Chain of Responsibility）** | 多个候选处理者按顺序，首个命中赢，后续短路 |
| 单个处理者 | **策略（Strategy）** | 每个 policy 是「权限裁决」算法族的可互换实现 |
| 组装 / 外部扩展 | **插件 / 微内核（Plugin / Microkernel）** | 极简内核 + 明确扩展点 + 可插拔的 policy |
| 落地辅助 | **注册表（Registry）+ 工厂（Factory）** | 收集插件；按 (agent, mode) 现场组装链 |

与 Casbin 的范式对比：

- **Casbin = 单一 Strategy + 数据驱动**：所有决策走同一个 matcher 表达式，差异压成 policy rows（数据）。
- **本方案 = 多 Strategy + 责任链组合**：每个 policy 是独立策略，差异靠代码，靠责任链组装。

行为密集型系统必须选后者——行为无法压成数据行。

---

## 五、目标方案

### 5.1 核心原则

1. **链编码「权限维度」，不编码「工具」**。新增工具不延长链；只有新增维度才加节点。
2. **两条贡献路径**：高频琐碎的具体内容走**数据路径**（规则）；低频有行为的新维度走**代码路径**（policy）。
3. **guard/review 下链，风险上链**：Harness 约束与产物审批以 executor hook 挂在 owning domain（见 5.4）；domain 贡献的**风险**维度才在 DI 中自注册 policy，镜像 v2 已有的「domain 自注册工具」。
4. **工具声明资源，通用维度消费**：bash/write/read 等只声明 `accesses`，文件/安全维度集中判断。

### 5.2 核心抽象

```ts
type Phase =
  | 'guard' | 'user-deny' | 'mode' | 'session'
  | 'user-ask' | 'default' | 'fallback';

interface PermissionPolicyEntry {
  name: string;
  phase: Phase;
  modes?: PermissionMode[];        // 声明在哪些 mode 生效（不再在 evaluate 里 if）
  agentTypes?: AgentType[];
  factory: (accessor: ServicesAccessor) => PermissionPolicy;
}

// App scope —— 收集所有 domain 的注册
interface IPermissionPolicyRegistry {
  register(entry: PermissionPolicyEntry): IDisposable;
  list(): readonly PermissionPolicyEntry[];
}
```

`PermissionPolicyService`（Agent scope）从硬编码列表改为「按 (agent, mode) 组装」：

```ts
this.policies = registry.list()
  .filter(e => !e.modes    || e.modes.includes(mode))
  .filter(e => !e.agentTypes || e.agentTypes.includes(agentType))
  .sort(byPhaseThenRegistrationOrder)
  .map(e => e.factory(accessor));
```

要点：

- `modes`/`agentTypes` 是**声明**，把现在 `YoloModeApprove` 里的 `if (mode !== 'yolo') return` 提到元数据。
- `factory` 而非 `instance`：节点可能依赖 agent-scoped 服务（mode、rules），需在 Agent scope 实例化——对称 `IToolDefinitionRegistry`(App) 存 factory、`IToolService`(Agent) 实例化工具。
- **不同 (agent, mode) 产出形状不同的链**：yolo 下 ask/fallback 阶段被物理过滤掉。

### 5.3 两条贡献路径

| 新增的是…… | 路径 | 链长变化 |
|---|---|---|
| 新工具、新组织规则、新用户偏好（"禁 `Bash(curl *)`"） | **数据路径**：往现有节点塞一条 `PermissionRule` | 不变 |
| 新横切行为（自定义审批 UI、审计日志、新 mode） | **代码路径**：注册一个新 policy 节点 | +1 |

绝大部分增长走数据路径——节点数被「行为种类」约束，规则数才随具体情况增长（规则匹配是廉价的 Set/glob）。

### 5.4 Domain 维度：guard/review 走 executor veto 事件，风险维度走链注册

**Harness 约束与产物审批不再上链。** 拥有它们的 domain 注册一个 `onBeforeExecuteTool` veto 监听器，通过事件对象自行裁决：

```ts
// src/plan/planService.ts —— 构造函数
constructor(@IAgentToolExecutorService executor, ...) {
  executor.onBeforeExecuteTool((event) => this.guardToolExecution(event));
}
```

- veto 事件没有 id、没有排序契约。监听器用 `event.veto(result)`（先到先得，终止裁决）、`event.allow()`（终局放行，终止包括 permission gate 自己在内的一切后续表态）、`event.pass(metadata)`（留痕放行，不终止他人表态）或 `event.waitUntil(factory)`（申报需要等外部输入的挂起裁决）表态。
- **guard（硬 deny）**：`event.veto(denyToolExecution(toolApproval.formatDenyMessage(...)))`。即时 veto 会压制所有待履行的 `waitUntil` factory——deny 之前绝不可能先弹出别人的审批。
- **review（产物审批）**：拦截自家工具，`event.waitUntil(() => ...requestToolApproval(event, ask, origin))`。factory 是 cold 的——executor 只会在所有监听器都跑完且无人 veto/allow 后才履行它，所以 review 的 Interaction 只可能在调用已经确定要继续时发出；不审批的情形一律不表态，让用户规则继续生效。
- **纯放行**：不要随便 `allow()`——把工具加进 `default-tool-approve` 白名单，保住用户 deny/ask 规则的优先权；`allow()` 留给 plan 文件写 guard 这种必须绕过整条权限链的场景。

**domain 贡献的风险维度仍走链**（下面的注册表路径）：domain 状态会改变*危险度*结论的，经 `IPermissionPolicyRegistry` 自注册 policy，镜像 v2 里「domain 在构造函数中 `toolRegistry.register(...)`」的现成做法。复杂 domain 可对外只注册**一个复合节点**（Composite），内部跑小链，避免泄漏内部顺序到全局。

### 5.5 工具运行时声明资源（`resolveExecution` / `accesses`）

工具在 `resolveExecution(input)` 里、执行前，用 `ToolAccesses.*` builder 声明访问的资源：

```ts
// packages/agent-core/src/tools/builtin/file/write.ts
resolveExecution(args: WriteInput): ToolExecution {
  const path = resolvePathAccessPath(args.path, { kaos, workspace, operation: 'write' });
  return {
    accesses: ToolAccesses.writeFile(path),            // 声明：写这个文件
    approvalRule: literalRulePattern(this.name, path),
    matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, ...),
    execute: () => this.execution(args, path),
  };
}
```

`ToolAccesses` 目前两类资源：

```ts
type ToolResourceAccess =
  | { kind: 'file'; operation: 'read'|'write'|'readwrite'|'search'; path: string; recursive?: boolean }
  | { kind: 'all' };   // 无法枚举的副作用（悲观、全局排他）
```

**两条互补通道**：

- **能枚举资源的**（write/read/edit/grep/glob）→ 用 `accesses`，通用文件维度自动覆盖。
- **不能枚举资源的**（bash 跑任意命令）→ 不声明 `accesses`，改用 `matchesRule` DSL（如 `Bash(rm *)` 按命令串 glob）。

**kaos 的定位**：kaos 是执行环境抽象（fs/process/pathClass），供文件维度做路径归一化与判断，**不是权限维度抽象本身**。权限语义在 kaos 之上的「文件访问」层。

**v2 演进方向**：扩展 `ToolResourceAccess` 联合类型，让非文件资源也能结构化声明：

```ts
type ToolResourceAccess =
  | { kind: 'file';      operation: FileOp; path: string; recursive?: boolean }
  | { kind: 'network';   operation: 'connect'; host: string }
  | { kind: 'shell';     command: string }
  | { kind: 'datastore'; operation: 'read'|'write'; table: string }
  | { kind: 'all' };
```

每新增一种资源类型，可对应加一个通用维度消费它；工具侧始终只负责**声明**。

### 5.6 维度归属

| 维度 | 拥有者 | 类型 |
|---|---|---|
| 外部钩子否决 | `externalHooks` domain | 通用 |
| 工具批量排他 | `swarm` domain —— `onBeforeExecuteTool` veto 监听器 | Harness 约束（链外） |
| Plan 写守卫 | `plan` domain —— `onBeforeExecuteTool` veto 监听器 | Harness 约束（链外） |
| Plan 审批 | `plan` domain —— 同监听器的 `waitUntil` + `toolApproval` | 产物审批（链外） |
| Goal 启动审批 | `goal` domain —— veto 监听器的 `waitUntil` + `toolApproval` | 产物审批（链外） |
| Goal 预算/过期拒绝 | `goal` domain —— `onBeforeExecuteTool` veto 监听器 | Harness 约束（链外） |
| btw 禁工具 | `btw` domain —— fork 上的 veto 监听器 | Harness 约束（链外） |
| 运行模式姿态（auto/yolo） | `permissionMode` domain（链节点，待「档位 × 路由」拆分） | 通用 |
| 静态配置规则 | `permissionRules` domain | 通用（数据路径） |
| 会话批准记忆 | `permissionRules` domain | 通用 |
| 敏感/特殊路径 | 通用「文件访问/安全」维度 | 通用（消费 `accesses`） |
| 工具内在风险 | 核心 permission（`default-tool-approve`） | 通用（消费工具声明） |
| 工作区写信任 | 通用「文件访问/安全」维度 | 通用（消费 `accesses`） |
| 兜底 | 核心 permission | 通用 |
| 审批往返 | `toolApproval` domain —— 供 gate 的 ask 与各域 review 共用 | 基础设施 |

规律：**Harness 约束与产物审批跟着 owning domain 走 `onBeforeExecuteTool` veto 监听器；风险维度以 policy 上链（注册表落地后自注册）；通用维度集中注册，靠工具声明的 `accesses` 跨工具生效。**

---

## 六、现状 vs 方案 对比

| 方面 | 现状（v1） | 目标方案 |
|---|---|---|
| 链的构造 | `policies/index.ts` 硬编码 19 个 `new` | `IPermissionPolicyRegistry` 收集，`compose(agent, mode)` 组装 |
| mode 处理 | policy 内部 `if (mode !== 'x') return` | 声明式 `modes` 元数据，compose 时过滤 |
| 按 agent 区分 | 散落 `agent.type === 'sub'` | 声明式 `agentTypes` 元数据 |
| 外部扩展 | 仅 `PreToolUse` hook 一个固定槽 | 注册表开放注册 policy（代码）+ rule（数据） |
| Domain 维度 | 集中在核心文件 | guard/review 走 domain 自带 `onBeforeExecuteTool` veto 监听器；风险维度走 domain 自注册 policy |
| 工具维度 | 工具声明 `accesses`，维度集中 | 不变，扩展 `ToolResourceAccess` 资源类型 |
| 决策行为 | 续体 + 副作用（已具备） | 不变（这是必须保留的核心能力） |
| 运行时性能 | 顺序链 + 短路 | 不变；节点增多时可加工具名索引优化 |

**不变的**：责任链内核、首个命中赢、`PermissionPolicyResult` 行为包、`resolveExecution`/`accesses` 机制。

**改变的**：链从「硬编码列表」变成「注册表 + 工厂组装」；mode/agent 从「内部 if」变成「声明式元数据」；维度归属从「核心集中」变成「domain 自注册」。

---

## 七、演进路径

渐进式，避免一步到位：

1. ~~**Domain 维度下沉**~~（已完成）。plan guard/review、goal-start review、swarm 批量排他、btw deny-all 已从链上移出，以 `onBeforeExecuteTool` veto 监听器挂在各自 domain（即时 `veto`/`allow`/`pass` 表态 + cold `waitUntil` factory 承载审批往返）；审批往返提取为共享的 `IAgentToolApprovalService`；`registerPolicy` 机制删除（btw 是唯一生产用例）。链上只剩 12 个危险度判定节点。
2. **档位 × 路由拆分**。把「危险度档位」（只读/读写/yolo——`yolo-mode-approve` 的实质）与「交互路由」（`auto-mode-approve` / `auto-mode-ask-user-question-deny` 的实质：不经用户地路由 ask 与 review）拆开；路由层落在 `session/approval` broker 上，剩余 3 个 mode policy 在此步离开链。
3. **注册表 + Composer（行为零变化）**。把 `PermissionPolicyService` 构造函数里硬编码的 `new`，改为从 `IPermissionPolicyRegistry` 读取并组装；mode 守门提升为 `modes` 元数据。获得多 agent/mode 可选链与外部注册入口。
4. **第四步（按需）：扩展资源类型**。当非文件资源（网络/DB/shell）需要结构化维度时，扩展 `ToolResourceAccess` 联合。
5. **第五步（按需）：匹配内核换 Casbin**。仅当外部规则真的需要 RBAC/ABAC 语义时，把数据路径的规则匹配内核换成 Casbin。不到此步不引。

---

## 八、待决问题

1. **Composite 节点的边界**：哪些 domain 内部用复合节点（隐藏子顺序），哪些直接注册多个 phase 节点？
2. **同 phase 多节点的排序**：注册顺序是否足够，还是需要显式 `order` 逃生舱？
3. **`ToolResourceAccess` 扩展节奏**：哪些非文件资源优先纳入（shell / network / datastore）？
4. **v1 → v2 迁移时机**：v2 权限子系统目前是 v1 类型/逻辑的薄包装，何时把 `accesses`、`PermissionPolicyResult` 等提升为正式 v2 类型？
5. **运行时性能阈值**：节点数达到多少时引入工具名索引（`byTool` 分派）优化？当前 12 个节点、首个命中短路，远未触及。
