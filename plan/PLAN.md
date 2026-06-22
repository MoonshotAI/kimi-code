# PLAN — `packages/agent-core` di-v3 重构（下一阶段）

> 从当前 `refactor/di-domain-runtime-services`（M0–M7 已完成）演进到 di-v3 目标架构。
> 目标设计参考 `/Users/moonshot/Projects/kimi-code-dev-2/plan/`（30 篇设计文档）。
> 现状评估见本目录 `CURRENT-STATE.md`（可选）与本次会话的偏离分析。

---

## 0. 背景

### 0.1 当前状态（M0–M7 已完成）

`refactor/di-domain-runtime-services` 分支已完成 DI 架构第二阶段（48 步，58 提交）：

- Session 拆为 command / query / runtime + SessionIndex + SessionRepository + SessionHost
- Agent 瘦身为句柄（Llm / Status / Rpc / Resume / Profile / Factory / 错误桥）
- CoreRPC 进程内零序列化切片（`getCoreApi()`，10 个 consumer domain 全部切走）
- 9 个 domain 的 service-skill 概念定稿
- 事件驱动：IDomainEventBus（per-agent）+ IEventService（全局）+ 投影边界 + ILifecycleService 钩子
- ICoreRuntime（替代 ICoreProcessService）+ KimiCore thin 线控
- 依赖方向 fence（runtime ↛ services / repository/index ↛ services / 不跨服务业务 import）
- 弃用 alias 清理 + 终态文档

### 0.2 di-v3 目标（`kimi-code-dev-2/plan/`）

agent-core 完整重架构为 **20 个 domain × scope 二维矩阵**：

- **20 个 domain**：Kosong / Kaos / Loop / Permission / Agent（收窄）/ Session / Workspace / MCP / Skill / Plugin / Profile / Hook / Cron / Background / Goal / Swarm / Records / Context / Todo / Web
- **scope = 子 InstantiationService**：Core / Session / Agent / Turn / ToolCall 五层 scope，每层一个 child container
- **service 通过 `registerScopedService(scope, I, Impl)` 注册**，ctor 注入 `I*Context` 取身份，方法签名不带 id
- **目录 `agent-core/<domain>/`**：契约 + 厚实现 + 工具同居
- **基础设施下沉**：`_base/`（di / event / logging / errors）+ `_utils/`（纯函数）；除 `_base/` / `_utils/` 与横切保留目录（rpc / config / flags / errors / logging 等）外，`agent-core/src/` 顶层其余目录均为 domain
- **barrel-only 暴露**：每层（`_base/<x>` / `_utils/<x>` / `<domain>`）只通过 `index.ts` 暴露公共面；consumer 从 barrel 导入（`#/<domain>`、`#/_base/di`、`@moonshot-ai/agent-core`），**禁止 deep-import 子模块**
- **禁止 re-import / re-export shim**：迁移不留旧路径 re-export alias；consumer 直接从新位置的 barrel 导入。旧路径在同一步内删除（不再「deprecated，P9 删除」）
- **工具按域注册**：每域 `register<Domain>Tools(accessor)`，`bootstrap.ts::registerAllBuiltinTools` 统一调
- **Agent 收窄**到 3–4 个服务（lifecycle / restorable / subagentHost）

### 0.3 偏离摘要

| 维度 | 当前 | di-v3 | 偏离 |
|---|---|---|---|
| domain 数 | ~10–12 | 20 | 中 |
| scope 机制 | per-agent ServiceCollection（raw createChild） | LifecycleScope + registerScopedService + I*Context | **极大** |
| 目录 | `services/<domain>/` + `agent/<domain>/` + `tools/` | `agent-core/<domain>/` 同居 | 大 |
| 工具 | 集中 `tools/` | 按域 `register<Domain>Tools` | 大 |
| 基础设施 | `di/` + `base/` + `utils/` | `_base/` + `_utils/` | 中 |
| Agent | ~25 服务字段 | 3–4 服务 | 中 |
| Session / Event / ICoreRuntime / fence | 已对齐 | 已对齐 | 小 |

---

## 1. 决策

### 1.1 总体策略：**演进式，不是推倒重来**

M0–M7 已为 di-v3 铺了地基（Session 拆分、事件系统、ICoreRuntime、fence、DI 容器）。下一阶段**复用这些地基**，在其上引入 di-v3 的核心机制（scope、目录、工具、domain 拆分），而不是从零开始。

**理由**：
- M0–M7 的代码基本都能在 di-v3 里找到归宿（被重组而非被丢弃）。
- 推倒重来会浪费 M0–M7 已验证的 session 拆分、事件系统、fence。
- 演进式允许分阶段验证，每阶段独立可测、可回滚。

### 1.2 核心决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | scope 机制引入时机 | **先建 scope 机制，再迁 domain** | scope 是 di-v3 的基础，domain 迁移依赖它 |
| 2 | 目录重组方式 | **逐 domain 迁移**（`services/<x>/` → `<x>/`），不是一次性大挪移 | 降低风险，每 domain 独立验证 |
| 3 | domain 拆分时机 | **先迁目录，再拆细**（先把现有 domain 迁到新结构，再把大的拆成 20 个） | 两步走，避免同时改结构 + 拆分 |
| 4 | 工具迁移 | **随 domain 迁移一起走**（每域迁完后，把对应工具搬进 `<domain>/tools/` 并写 `register<Domain>Tools`） | 工具跟随 domain，避免二次搬运 |
| 5 | 基础设施下沉 | **先于 domain 迁移**（先把 di/event/logging/errors/utils 沉到 `_base/`/`_utils/`，domain 迁移时引用新位置） | 避免 domain 迁移后还要改 import |
| 6 | Agent 收窄 | **最后做**（等所有 domain 迁完 + scope 稳定后，把 Agent 剩余职责拆到 domain） | Agent 收窄依赖所有 domain 就位 |
| 7 | 兼容策略 | **每阶段保持 green**（typecheck + 全套 test + fence），不允许长时间 broken | 每步可回滚 |
| 8 | registerSingleton → registerScopedService | **逐 service 迁移**（每个 service 标注 scope 后迁移注册方式） | 渐进式，避免大爆炸 |

### 1.3 复用 M0–M7 的地基（不重复造）

| M0–M7 成果 | di-v3 中的归宿 | 复用方式 |
|---|---|---|
| Session cmd/query/runtime 拆分 | Session 域的 ISessionService / ISessionQueryService / ISessionRuntimeService | 直接复用，搬到 `session/` |
| SessionIndex | Session 域的 ISessionIndex | 直接复用 |
| SessionRepository（runtime） | Session 域的 ISessionRepository | 直接复用 |
| SessionHost | Session 域的 SessionHost（manager 候选） | 演进为 ISessionLifecycleService（manager） |
| IDomainEventBus + IEventService + 投影 | RPC-Event 域 | 直接复用 |
| ILifecycleService 钩子 | 各 scope manager 的钩子 | 拆分到 Session / Agent / Turn manager |
| ICoreRuntime + KimiCore thin 线控 | RPC-Event 域的 ICoreProcessService + KimiCore | 直接复用 |
| getCoreApi() 进程内切片 | RPC-Event 域 | 直接复用 |
| 依赖方向 fence | lint + scope 机制 | 保留 test fence + 加 lint |
| DI 容器（di/） | `_base/di/` | 下沉到 `_base/` |
| 9 个 domain concept doc | di-v3 各 domain 定稿 | 演进为 di-v3 定稿 |

### 1.4 拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| 推倒重来（从 main 重新写 di-v3） | 浪费 M0–M7 已验证的地基；风险高 |
| 一次性大挪移（一个 PR 迁完所有 domain） | 风险极高，无法独立验证 / 回滚 |
| 先拆 domain 再建 scope | domain 拆分依赖 scope 机制，顺序错了 |
| 保留 `services/` 不动 | di-v3 明确要求 `services/` 消失，保留会持续偏离 |
| 工具继续集中 `tools/` | di-v3 明确工具按域注册，集中会持续偏离 |
| 迁移时保留旧路径 re-export alias（deprecated，后续 P9 删除） | 违反 barrel-only / 不允许 re-import；留下 deep-import 与双入口；改为同一步内全量改写 consumer 到 barrel 并立即删除旧路径 |

---

## 2. 目标架构（终态）

### 2.1 目录结构（终态）

```
packages/agent-core/src/
├── scope/                  # scope-DI 机制（LifecycleScope / registry / builder / context）
├── kosong/                 # 域 1：LLM provider / 模型 IO
├── kaos/                   # 域 2：执行环境（fs / process / shell / terminal）
├── loop/                   # 域 3：turn 推进（ITurnService / IToolService / TurnFlow）
├── permission/             # 域 4：权限（跨四层 scope）
├── agent/                  # 域 5：组合根（收窄到 3-4 服务）
├── session/                # 域 6：session（cmd/query/runtime/repository/index/manager）
├── workspace/              # 域 7：workspace
├── mcp/                    # 域 8：MCP
├── skill/                  # 域 9：skill
├── plugin/                 # 域 10：plugin（runtime，已对齐）
├── profile/                # 域 11：profile
├── hook/                   # 域 12：hook
├── cron/                   # 域 13：cron（新）
├── background/             # 域 14：background（新）
├── goal/                   # 域 15：goal（新）
├── swarm/                  # 域 16：swarm（新）
├── records/                # 域 17：records + replay（新）
├── context/                # 域 18：context + compaction + injection（新）
├── todo/                   # 域 19：todo（新）
├── web/                    # 域 20：web（新）
├── logging/                # 横切基础设施 service
├── rpc/                    # 跨进程基础设施（CoreAPI / KimiCore / IEventService / createRPC）
├── config/                 # Kimi 专属（保留）
├── flags/                  # Kimi 专属（保留）
├── errors/                 # Kimi error 类（保留）
├── telemetry.ts            # Kimi telemetry（保留）
├── _base/                  # 内部基础设施（di / event / logging / errors）
├── _utils/                 # 内部工具函数（abort / fs / slug / xml / ...）
└── index.ts
```

### 2.2 scope 机制（终态）

```ts
// scope/lifecycle.ts
export enum LifecycleScope { Core, Session, Agent, Turn, ToolCall }

// scope/registry.ts
export function registerScopedService<I>(
  scope: LifecycleScope,
  id: ServiceIdentifier<I>,
  descriptor: SyncDescriptor<I>,
  type: InstantiationType,
  options?: { replace?: boolean },
): void;

// service ctor 注入身份
class FooService {
  constructor(@IAgentContext private readonly ctx: IAgentContext) { }
  // 方法签名不带 agentId
  doSomething(): void { this.ctx.id ... }
}
```

### 2.3 每个 domain 目录的结构（终态）

```
<domain>/
├── <domain>.ts             # 契约：IXxxService + createDecorator + sentinel errors
├── <domain>Service.ts      # 厚实现：class XxxService
├── <support files>         # 状态机 / scheduler / persistence / parser / provider 适配器
├── tools/                  # 该域提供的工具（如有）
│   └── <tool>.ts
└── index.ts                # export + register<Domain>Services + register<Domain>Tools
```

**barrel-only 暴露（强制）**：每层（`<domain>` / `_base/<x>` / `_utils/<x>`）的 `index.ts` 是其唯一公共面。consumer 一律从 barrel 导入（`#/session`、`#/_base/di`、`@moonshot-ai/agent-core`），禁止 deep-import 子模块（如 `#/_base/di/instantiation`、`#/session/store`）。迁移不留旧路径 re-export alias（不允许 re-import）：旧路径在同一步内删除，consumer 全量改写为 barrel 导入。

### 2.4 工具注册（终态）

```ts
// <domain>/index.ts
export function register<Domain>Tools(accessor: IServiceAccessor): IDisposable { ... }

// agent-core/bootstrap.ts
export function registerAllBuiltinTools(accessor: IServiceAccessor): IDisposable {
  return new DisposableStore([
    registerKaosTools(accessor),
    registerWebTools(accessor),
    registerCronTools(accessor),
    // ...
  ]);
}
```

---

## 3. 阶段划分（高层）

| 阶段 | 主题 | 输出 | 依赖 |
|---|---|---|---|
| **P0** | 地基与护栏 | fence 扩展、snapshot、scope 设计定稿 | — |
| **P1** | scope 机制 | LifecycleScope / ScopeRegistry / registerScopedService / I*Context / ScopeBuilder / manager 模式 | P0 |
| **P2** | 基础设施下沉 | `_base/` + `_utils/` + lint | P1 |
| **P3** | domain 目录迁移（现有 domain） | `services/<x>/` → `<x>/`，逐 domain | P2 |
| **P4** | domain 拆分（→ 20） | Cron / Background / Goal / Swarm / Records / Context / Todo / Web 独立成域 | P3 |
| **P5** | 工具按域注册 | `register<Domain>Tools` + `registerAllBuiltinTools` | P3, P4 |
| **P6** | service scope 标注 | 逐 service 从 registerSingleton 迁到 registerScopedService + I*Context 注入 | P1, P3 |
| **P7** | Agent 收窄 | Agent 瘦到 3–4 服务，剩余职责拆到 domain | P4, P6 |
| **P8** | bootstrap 生命周期 | 5 阶段启动 + shutdown 反向链 + Restorable resume | P6, P7 |
| **P9** | 收尾 + 文档 | 删除 deprecated、终态文档、changeset | P8 |

---

## 4. 关键风险与对策

| 风险 | 对策 |
|---|---|
| scope 机制引入破坏现有 DI | 先建 scope 机制，跑通 ScopeBuilder + 1 个试点 service（如 ILogService），再批量迁移 |
| 目录重组破坏 import | 逐 domain 迁移，每域迁完跑全套 test；用 codemod / 批量 sed 改 import |
| 工具搬迁破坏工具注册 | 每域迁完工具后，写 `register<Domain>Tools` 并接入 bootstrap；保持工具注册表 green |
| domain 拆分破坏现有 service 边界 | 先迁目录（保持边界），再拆细（一次拆一个 domain） |
| scope 迁移破坏 per-agent 行为 | 每 service 迁到 registerScopedService 后，验证 per-agent 实例化 + 身份注入正确 |
| Agent 收窄破坏 consumer | 最后做，等所有 domain 就位；consumer 已通过 facade 访问，影响可控 |
| 长时间 broken | 每阶段保持 green；不允许跨 phase 的 broken 状态 |

---

## 5. 验收标准（终态）

- `packages/agent-core/src/services/` 消失（迁到 `<domain>/`）
- 20 个 domain 目录全部就位，每个有契约 + 厚实现 + 工具（如有）+ `register<Domain>Tools`
- scope 机制就位：LifecycleScope + registerScopedService + I*Context + ScopeBuilder + manager
- 所有 service 标注 scope 并通过 registerScopedService 注册
- `_base/`（di/event/logging/errors）+ `_utils/` 就位；每层只通过 `index.ts` 暴露；lint + fence 强制依赖方向 + barrel-only
- 无旧路径 re-export alias；consumer 全部从 barrel 导入（`grep` 旧路径 0 命中，无例外；无 deep-import）
- Agent 收窄到 3–4 服务
- `bootstrap.ts::registerAllBuiltinTools` 是唯一工具注册入口
- 全套 test + typecheck + fence green
- server-e2e 0 diff（如可跑）

---

## 6. 与 di-v3 设计文档的对应

本 PLAN 是**执行计划**，目标架构以 `kimi-code-dev-2/plan/` 的 30 篇设计文档为准。本 PLAN 不重复设计文档的内容，只规定**如何从当前状态演进到目标**。

执行时每个 phase 需回读对应的 di-v3 设计文档（见 ROADMAP 每步的 `源` 字段）。

---

## 7. 估算

| 阶段 | 规模 | 估时（单人） |
|---|---|---|
| P0 地基 | 小 | 2–3d |
| P1 scope 机制 | 大 | 8–12d |
| P2 基础设施下沉 | 中 | 3–5d |
| P3 domain 目录迁移 | 大 | 10–15d（~10 个 domain） |
| P4 domain 拆分 | 大 | 10–15d（~8 个新 domain） |
| P5 工具按域注册 | 中 | 5–8d |
| P6 service scope 标注 | 大 | 8–12d |
| P7 Agent 收窄 | 中 | 3–5d |
| P8 bootstrap 生命周期 | 中 | 3–5d |
| P9 收尾 | 小 | 2–3d |
| **合计** | | **约 54–81 单人日**（11–16 周） |

> 注：di-v3 是比 M0–M7（47.5 单人日）更大的重构。3 人并行可压缩到 5–7 周。
