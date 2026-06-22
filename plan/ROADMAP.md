# ROADMAP — `packages/agent-core` di-v3 重构（下一阶段）

> 配套 [`PLAN.md`](./PLAN.md)。把 PLAN §3 的 10 个阶段原子化为「一个提交、一次验证」的步骤。
> 目标架构以 `/Users/moonshot/Projects/kimi-code-dev-2/plan/` 的 30 篇设计文档为准。
> 起点：`refactor/di-domain-runtime-services`（M0–M7 已完成）。

---

## Global constraints

- 每个提交遵循 Conventional Commits。允许 scope：`agent-core` / `server` / `node-sdk` / `test` / `docs` / `changeset`。
- 每个提交必须通过：
  ```bash
  pnpm --filter @moonshot-ai/agent-core typecheck
  pnpm --filter @moonshot-ai/server typecheck
  pnpm --filter @moonshot-ai/agent-core test
  pnpm --filter @moonshot-ai/server test
  pnpm --filter @moonshot-ai/agent-core test -- dependency-direction
  ```
  改动运行时 wiring 的提交额外跑 `packages/server-e2e` smoke（如可跑；user 已接受无 e2e 风险）。
- 禁止 `it.skip` / `test.skip`。失败测试修复、删除或拆到后续 step。
- 用户可见行为变化需要 `.changeset/<slug>.md`。
- decorator 字符串：M0–M7 保留了 `'coreProcessService'` 等，本 ROADMAP 在 P9 才允许改名（需全 consumer audit）。
- 依赖方向 fence（M7.2 已完整）：每步必须保持 green；新增 domain 时同步更新 fence 规则（如需）。
- **barrel-only 暴露（强制）**：每层（`_base/<x>` / `_utils/<x>` / `<domain>`）只通过 `index.ts` 暴露公共面；consumer 从 barrel 导入（`#/<domain>` / `#/_base/di` / `@moonshot-ai/agent-core`），禁止 deep-import 子模块（如 `#/_base/di/instantiation`）。
- **禁止 re-import / re-export shim**：迁移不留旧路径 re-export alias；consumer 直接从新位置的 barrel 导入。因此 P2 / P3 的迁移步骤必须**全量改写 consumer import**，旧路径在**同一步内删除**（不再「deprecated，P9 删除」）。
- Step ID：`P<phase>.<step>`。Phase 对应 PLAN §3 的 P0–P9。

---

## P0 · 地基与护栏（2–3d）

### P0.1 test(agent-core): API surface snapshot 扩展

- 改：
  - `packages/server/test/api-surface.snapshot.test.ts`（extend）
  - `packages/node-sdk/test/api-surface.snapshot.test.ts`（extend）
- 实现：
  - 扩展 M0.2 的 snapshot，覆盖 di-v3 会影响的 route / export（如新增 domain 的 SDK surface）。
  - 当前 di-v3 还没改 surface，snapshot 是当前状态的基线。
- 测：snapshot 生成；后续 diff 为 0。
- 验：`pnpm --filter @moonshot-ai/server test -- api-surface` exit 0；node-sdk 同。
- 依：—
- 源：M0.2
- 耗：0.5d

### P0.2 test(agent-core): dependency-direction fence di-v3 扩展

- 改：
  - `packages/agent-core/test/dependency-direction.test.ts`（extend）
- 实现：
  - 在 M7.2 的 3 条规则上，加入 di-v3 目标目录结构的规则预留：
    - `_utils/` ← `_base/` ← `domains/`（lint 强制；test 先预留，P2 落地后启用）。
    - `agent-core/<domain>/` 之间不互引 impl（通过接口 + IServiceAccessor）。
  - 当前 di-v3 目录还不存在，新规则先用 fixture 验证（正例：现状 0 违例；反例：fixture 违例报错）。
- 测：≥ 2 个新 case（di-v3 目录规则的 fixture）。
- 验：`pnpm --filter @moonshot-ai/agent-core test -- dependency-direction` exit 0；≥ 9 cases（M7.2 的 7 + 新 2）。
- 依：—
- 源：M7.2、`services/AGENTS.md`
- 耗：1d

### P0.3 docs: scope 机制设计定稿

- 改：
  - `.agents/skills/service-skill/explanation/scope-mechanism.md`（new）
- 实现：
  - 把 di-v3 的 scope 机制（LifecycleScope / registerScopedService / I*Context / ScopeBuilder / manager 模式）整理成一份中文定稿，作为 P1 的实施依据。
  - 引用 `kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md`。
- 测：—（纯文档）
- 验：阅读定稿；确认 P1 可据此实施。
- 依：—
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md`
- 耗：1d

**P0 acceptance：** fence 扩展 + snapshot 守住边界；scope 机制设计定稿；P1 可启动。

---

## P1 · scope 机制（8–12d）

> 前置：P0.3 scope 设计定稿完成。本阶段落地 di-v3 的核心机制。

### P1.1 feat(agent-core): LifecycleScope enum + ScopeRegistry

- 改：
  - `packages/agent-core/src/scope/lifecycle.ts`（new，LifecycleScope enum）
  - `packages/agent-core/src/scope/registry.ts`（new，ScopeRegistry + registerScopedService）
  - `packages/agent-core/test/scope/registry.test.ts`（new）
- 实现：
  - `LifecycleScope { Core, Session, Agent, Turn, ToolCall }`。
  - `ScopeRegistry`：process-wide `Map<LifecycleScope, Map<ServiceId, SyncDescriptor>>`。
  - `registerScopedService(scope, id, descriptor, type, options?)`：写入 registry（lazy，不实例化）；`registerScopedService(Core, ...)` 是 `registerSingleton` 的别名；duplicate 时 last-write-wins + warn，`{ replace: true }` 静默。
  - 注册必须在第一次 `scopeBuilder.build()` 前；之后注册 warn + 忽略。
- 测：register / get / duplicate warn / replace / Core 别名 / 注册时机。
- 验：≥ 6 cases。
- 依：—
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §2–3
- 耗：1.5d

### P1.2 feat(agent-core): scope identity contexts

- 改：
  - `packages/agent-core/src/scope/context/sessionContext.ts`（new，ISessionContext）
  - `packages/agent-core/src/scope/context/agentContext.ts`（new，IAgentContext）
  - `packages/agent-core/src/scope/context/turnContext.ts`（new，ITurnContext）
  - `packages/agent-core/src/scope/context/toolCallContext.ts`（new，IToolCallContext）
  - `packages/agent-core/test/scope/context.test.ts`（new）
- 实现：
  - `ISessionContext { id, parentId?: undefined, abortSignal, executionScope }`。
  - `IAgentContext { id, parentId: sessionId, abortSignal, executionScope }`。
  - `ITurnContext { id, parentId: agentId, abortSignal, executionScope }`。
  - `IToolCallContext { id, parentId: turnId, abortSignal, executionScope }`。
  - 每个 context 是 decorator（createDecorator），service ctor 通过 `@IAgentContext` 注入。
- 测：每个 context 的字段 + decorator 解析。
- 验：≥ 4 cases。
- 依：P1.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §4
- 耗：1d

### P1.3 feat(agent-core): IScopeHandle + ScopeBuilder

- 改：
  - `packages/agent-core/src/scope/handle.ts`（new，IScopeHandle）
  - `packages/agent-core/src/scope/builder.ts`（new，SessionScopeBuilder / AgentScopeBuilder / TurnScopeBuilder）
  - `packages/agent-core/test/scope/builder.test.ts`（new）
- 实现：
  - `IScopeHandle { id, scope, accessor, onWillDispose, onDidDispose, dispose() }`。
  - `ScopeBuilder` 4 步 pipeline：① inject scope identity context；② install Pattern-1 statically registered services as SyncDescriptors；③ reserved build hook（Pattern 2，未启用）；④ reserved post-build interceptor（未启用）；然后 `parent.createChild(collection)` 返回 handle。
  - `dispose()`：倒序 dispose child services。
- 测：builder 4 步 / handle dispose / 倒序 dispose / identity context 注入。
- 验：≥ 6 cases。
- 依：P1.1, P1.2
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §5–6
- 耗：2d

### P1.4 feat(agent-core): manager service pattern

- 改：
  - `packages/agent-core/src/scope/manager.ts`（new，manager service 基类 / 约定）
  - `packages/agent-core/test/scope/manager.test.ts`（new）
- 实现：
  - manager service 住父 scope，是子 scope 的唯一上行事件发布点。
  - manager 通过 `child.accessor.get(...)` 主动 attach 子 scope 事件源，re-emit 为 collection-view 事件（加 child id）。
  - `dispose()` 配对：`try { await childScope.dispose() } finally { manager.onDidXxx.fire(); eventBus.publish(...) }`。
  - 子 scope service 不反向调用 manager 的写方法。
- 测：manager attach / onDid* fire / dispose 配对 / 子不反向写。
- 验：≥ 5 cases。
- 依：P1.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §7–8
- 耗：1.5d

### P1.5 feat(agent-core): scope 试点 — ILogService 迁到 registerScopedService

- 改：
  - `packages/agent-core/src/logging/logService.ts`（new or extend，ILogService）
  - `packages/agent-core/src/logging/logServiceImpl.ts`（new or extend）
  - `packages/agent-core/test/logging/logService.test.ts`（new or extend）
- 实现：
  - 把 `ILogService`（Core scope）从 `registerSingleton` 迁到 `registerScopedService(Core, ILogService, ...)`。
  - ctor 不再依赖 id（Core scope 无身份）。
  - 验证 ScopeBuilder.build(Core) 能解析 ILogService。
- 测：ILogService 通过 registerScopedService 注册 + 解析 + 行为不变。
- 验：≥ 3 cases；全套 test green。
- 依：P1.1, P1.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Logging-Domain.md`
- 耗：1d

### P1.6 feat(agent-core): scope 机制 barrel + index

- 改：
  - `packages/agent-core/src/scope/index.ts`（new，barrel）
  - `packages/agent-core/src/index.ts`（export scope）
- 实现：
  - `scope/index.ts` 导出 LifecycleScope / registerScopedService / I*Context / ScopeBuilder / IScopeHandle。
  - 顶层 `index.ts` export scope（触发 registerScopedService side effects）。
- 测：barrel export 完整。
- 验：typecheck green；scope API 可从 `@moonshot-ai/agent-core` 导入。
- 依：P1.1–P1.5
- 源：—
- 耗：0.5d

**P1 acceptance：** scope 机制完整可用；ILogService 试点通过 registerScopedService 注册；P2 / P3 可启动。

---

## P2 · 基础设施下沉（3–5d）

> 前置：P1 scope 机制完成。本阶段把 di / event / logging / errors / utils 沉到 `_base/` + `_utils/`。**每层只通过 `index.ts` 暴露；迁移不留 re-export alias；consumer 全量改写为 barrel 导入，旧路径同一步内删除。**

### P2.1 refactor(agent-core): sink di/ → _base/di/

- 改：
  - `packages/agent-core/src/_base/di/`（new，从 `di/` 迁入）
  - `packages/agent-core/src/di/`（delete，**不留 re-export alias**）
  - 所有 consumer import 全量改写为 `#/_base/di` barrel（bare `../di` / `#/di` 与 deep `../di/<x>` / `#/di/<x>` 全部收敛到 barrel）
- 实现：
  - 把 `di/` 的全部内容（instantiation / descriptors / extensions / serviceCollection / instantiationService / lifecycle / errors / graph / test / testInstantiationService / util）迁到 `_base/di/`。
  - 确保 `_base/di/index.ts` 是唯一公共面，导出全部需要的符号（含 test 工具如 `TestInstantiationService` / `createServices`，以便测试从 barrel 导入）。
  - 全量改写所有 consumer import 为 `#/_base/di` barrel（或相对 `../_base/di` / `../../_base/di`）；不再 deep-import 子模块。
  - 删除 `di/`（不留 alias）。同步处理 `package.json` `exports` 中 `@moonshot-ai/agent-core/di/*` 子路径（改为指向 `_base/di` 或移除，外部统一从包根 barrel 导入）。
- 测：typecheck green；全套 test green；DI 行为不变。
- 验：
  - `grep -rEn "from ['\"][^'\"]*?/di['\"]" packages/agent-core/src packages/agent-core/test` 0 命中（无 alias，无例外）。
  - `grep -rEn "#/(di|_base/di)/" packages/agent-core/src packages/agent-core/test` 0 命中（禁止 deep-import 子模块）。
- 依：P1
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §1
- 耗：1d

### P2.2 refactor(agent-core): sink base/common/event → _base/event/

- 改：
  - `packages/agent-core/src/_base/event/`（new，从 `base/common/event.ts` 迁入，含 `index.ts` barrel）
  - `packages/agent-core/src/base/common/event.ts`（delete，**不留 alias**）
  - consumer import 全量改写为 `#/_base/event` barrel
- 实现：
  - 把 `base/common/event.ts`（Event / Emitter）迁到 `_base/event/`，新增 `_base/event/index.ts` barrel 暴露公共面。
  - 内部依赖（如对 DI 的引用）改为从 `_base/di` barrel 导入（`../di`），不 deep-import `../di/lifecycle`。
  - 全量改写所有 consumer import 为 `#/_base/event` barrel；删除 `base/common/event.ts`（不留 alias）。如 `base/common/` 因迁出而变空，一并清理。
- 测：typecheck green；Event / Emitter 行为不变。
- 验：
  - `grep -rEn "base/common/event" packages/agent-core/src packages/agent-core/test` 0 命中（无 alias）。
  - `grep -rEn "#/_base/event/" packages/agent-core/src packages/agent-core/test` 0 命中（禁止 deep-import）。
- 依：P2.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §2
- 耗：0.5d

### P2.3 refactor(agent-core): sink logging/ → _base/logging/

- 改：
  - `packages/agent-core/src/_base/logging/`（new，无 DI 的 Logger / RootLogger / sinks）
  - `packages/agent-core/src/logging/`（保留 ILogService / ISessionLogService，引用 `_base/logging`）
- 实现：
  - 把无 DI 的 `Logger` / `RootLogger` / sinks 沉到 `_base/logging/`。
  - `logging/`（DI service：ILogService / ISessionLogService）保留，引用 `_base/logging`。
- 测：typecheck green；logging 行为不变。
- 验：`grep "from ['\"][^'\"]*?/logging['\"]" packages/agent-core/src` 仅命中 `logging/`（DI service）和 `_base/logging`。
- 依：P2.2
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §3、`2026.06.22-Logging-Domain.md`
- 耗：1d

### P2.4 refactor(agent-core): sink errors/unexpectedError → _base/errors/

- 改：
  - `packages/agent-core/src/_base/errors/`（new，从 `errors/unexpectedError.ts` 迁入，含 `index.ts` barrel）
  - `packages/agent-core/src/errors/unexpectedError.ts`（delete，**不留 alias**）
  - consumer import 全量改写为 `#/_base/errors` barrel
- 实现：
  - 把 `errors/unexpectedError.ts` 沉到 `_base/errors/`，新增 `_base/errors/index.ts` barrel。
  - 更新 `_base/di/lifecycle.ts` 等内部引用为从 `#/_base/errors` barrel 导入。
  - Kimi 专属 error 类（`errors/` 其余）保留在 `errors/`。
  - 删除 `errors/unexpectedError.ts`（不留 alias）。
- 测：typecheck green；unexpectedError 行为不变。
- 验：
  - `grep -rEn "errors/unexpectedError" packages/agent-core/src packages/agent-core/test` 0 命中（无 alias）。
  - `grep -rEn "#/_base/errors/" packages/agent-core/src packages/agent-core/test` 0 命中（禁止 deep-import）。
- 依：P2.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §4
- 耗：0.5d

### P2.5 refactor(agent-core): sink utils/ → _utils/

- 改：
  - `packages/agent-core/src/_utils/`（new，从 `utils/` 迁入；每个子目录含 `index.ts` barrel）
  - `packages/agent-core/src/utils/`（delete，**不留 alias**）
  - consumer import 全量改写为 `#/_utils/<x>` barrel
- 实现：
  - 把 `utils/` 的纯函数（abort / fs / hero-slug / workdir-slug / xml-escape / render-prompt / types / per-id-json-store / proxy）沉到 `_utils/{abort,fs,slug,xml,template,types,persistence,net}/`，每个子目录含 `index.ts` barrel。
  - `utils/{tokens,completion-budget}.ts` 不沉（依赖 kosong types，搬到 `kosong/`，P3 处理）。
  - 全量改写 consumer import 为 `#/_utils/<x>` barrel；删除 `utils/`（不留 alias）。
- 测：typecheck green；utils 行为不变。
- 验：
  - `grep -rEn "from ['\"][^'\"]*?/utils/" packages/agent-core/src packages/agent-core/test` 0 命中（无 alias）。
  - `grep -rEn "#/_utils/[a-z]+/" packages/agent-core/src packages/agent-core/test` 0 命中（禁止 deep-import 子模块；barrel 为 `#/_utils/<x>`）。
- 依：P2.4
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §5
- 耗：1.5d

### P2.6 lint: enforce _utils ← _base ← domains

- 改：
  - `.oxlintrc.json`（或 eslint config，加 no-restricted-paths）
  - `packages/agent-core/test/dependency-direction.test.ts`（extend，启用 P0.2 预留的 _utils ← _base ← domains 规则）
- 实现：
  - lint 强制：`_utils/` 不 import `_base/` / domains；`_base/` 不 import domains；domains 不 import `_base/`/`_utils/` 的内部（仅通过 barrel）。
  - dependency-direction fence 启用 _utils ← _base ← domains 规则。
- 测：lint green；fence 启用新规则；现状 0 违例。
- 验：lint + fence green。
- 依：P2.5
- 源：`kimi-code-dev-2/plan/2026.06.22-Infrastructure-To-Base-Utils.md` §6
- 耗：0.5d

**P2 acceptance：** di / event / logging / errors / utils 沉到 `_base/` + `_utils/`；每层只通过 `index.ts` 暴露；无旧路径 re-export alias；consumer 全部从 barrel 导入；lint + fence 强制依赖方向 + barrel-only；P3 可启动。

---

## P3 · domain 目录迁移（现有 domain）（10–15d）

> 前置：P2 基础设施下沉完成。本阶段把现有 `services/<domain>/` 逐 domain 迁到 `agent-core/<domain>/`（契约 + 厚实现 + 工具同居）。
> 每次迁一个 domain，独立验证。

### P3.0 docs: domain 迁移规范

- 改：
  - `.agents/skills/service-skill/explanation/domain-migration.md`（new）
- 实现：
  - 规定每个 domain 迁移的步骤：① 建 `agent-core/<domain>/`；② 移契约（`<domain>.ts`）；③ 移厚实现（`<domain>Service.ts`）；④ 移工具（`<domain>/tools/`）；⑤ 更新 import；⑥ 写 `register<Domain>Services` + `register<Domain>Tools`；⑦ 验证。
- 测：—（纯文档）
- 验：阅读规范；P3.x 据此实施。
- 依：P2
- 源：PLAN §2.3
- 耗：0.5d

### P3.1 refactor(agent-core): migrate session domain → session/

- 改：
  - `packages/agent-core/src/session/`（extend：迁入 `services/session/` 的契约 + impl）
  - `packages/agent-core/src/services/session/`（delete）
  - import 更新
- 实现：
  - 把 `services/session/` 的 `session.ts`（契约）+ `sessionService.ts` / `sessionQueryService.ts` / `sessionRuntimeService.ts` / `sessionIndex.ts`（impl）迁到 `session/`（已有 SessionHost / SessionRepository）。
  - 更新 import（`services/session` → `session`）。
  - `session/index.ts` export ISessionService / ISessionQueryService / ISessionRuntimeService / ISessionIndex / SessionRepository / SessionHost。
- 测：session 行为不变；server session route 0 diff。
- 验：全套 test green；fence green；`grep "services/session" packages` 0 命中。
- 依：P3.0
- 源：`kimi-code-dev-2/plan/2026.06.22-Session-Domain.md`
- 耗：2d

### P3.2 refactor(agent-core): migrate workspace domain → workspace/

- 改：
  - `packages/agent-core/src/workspace/`（new，从 `services/workspace/` 迁入）
  - `packages/agent-core/src/services/workspace/`（delete）
  - import 更新
- 实现：
  - 把 `services/workspace/` 的 `workspace.ts` / `workspaceService.ts` / `workspaceRegistry.ts` / `workspaceFs.ts` 迁到 `workspace/`。
  - 更新 import。
- 测：workspace 行为不变。
- 验：全套 test green；`grep "services/workspace" packages` 0 命中。
- 依：P3.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Workspace-Domain.md`
- 耗：1d

### P3.3 refactor(agent-core): migrate mcp domain → mcp/

- 改：
  - `packages/agent-core/src/mcp/`（extend：迁入 `services/mcp/`）
  - `packages/agent-core/src/services/mcp/`（delete）
  - import 更新
- 实现：
  - 把 `services/mcp/` 的 `mcp.ts` / `mcpService.ts` 迁到 `mcp/`（已有 connection-manager）。
  - 更新 import。
- 测：mcp 行为不变。
- 验：全套 test green；`grep "services/mcp" packages` 0 命中。
- 依：P3.2
- 源：`kimi-code-dev-2/plan/2026.06.22-MCP-Domain.md`
- 耗：1d

### P3.4 refactor(agent-core): migrate skill domain → skill/

- 改：
  - `packages/agent-core/src/skill/`（extend：迁入 `services/skill/`）
  - `packages/agent-core/src/services/skill/`（delete）
  - import 更新
- 实现：
  - 把 `services/skill/` 的 `skill.ts` / `skillService.ts` 迁到 `skill/`（已有 registry / agent skill）。
  - 更新 import。
- 测：skill 行为不变。
- 验：全套 test green；`grep "services/skill" packages` 0 命中。
- 依：P3.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Skill-Domain.md`
- 耗：1d

### P3.5 refactor(agent-core): migrate terminal domain → kaos/terminal

- 改：
  - `packages/agent-core/src/kaos/terminal.ts`（new，从 `services/terminal/` 迁入）
  - `packages/agent-core/src/services/terminal/`（delete）
  - import 更新
- 实现：
  - di-v3 把 terminal 归入 Kaos 域（执行环境）。把 `services/terminal/` 的 `terminal.ts` / `terminalService.ts` 迁到 `kaos/terminal.ts`（或 `kaos/` 下）。
  - 更新 import。
- 测：terminal 行为不变。
- 验：全套 test green；`grep "services/terminal" packages` 0 命中。
- 依：P3.4
- 源：`kimi-code-dev-2/plan/2026.06.21-Kosong-Kaos-Loop-v2.md` §2
- 耗：1d

### P3.6 refactor(agent-core): migrate config domain → config/

- 改：
  - `packages/agent-core/src/config/`（extend：迁入 `services/config/`）
  - `packages/agent-core/src/services/config/`（delete）
  - import 更新
- 实现：
  - 把 `services/config/` 的 `config.ts` / `configService.ts` 迁到 `config/`。
  - 更新 import。
- 测：config 行为不变。
- 验：全套 test green；`grep "services/config" packages` 0 命中。
- 依：P3.5
- 源：—
- 耗：0.5d

### P3.7 refactor(agent-core): migrate message + tool + modelCatalog + fs + fileStore + approval + question + environment + logger + event + authSummary + oauth + auth + task + prompt + agentHost + userInteraction

- 改：
  - 每个 `services/<domain>/` → `agent-core/<domain>/`（或对应 runtime 位置）
  - import 更新
- 实现：
  - 逐个迁移剩余的 `services/<domain>/` 到对应位置（message → message/ 或 loop/；tool → loop/；modelCatalog → kosong/；fs → kaos/；fileStore → fileStore/ 或 kaos/；approval/question → permission/；environment → environment/ 或 kaos/；logger → logging/；event → rpc/；authSummary/oauth/auth → kosong/；task → background/；prompt → session/；agentHost/userInteraction → 删除或合并）。
  - 每个 domain 独立验证。
- 测：每个 domain 行为不变。
- 验：全套 test green；`grep "services/" packages/agent-core/src` 0 命中（`services/` 消失）。
- 依：P3.6
- 源：各 di-v3 domain 文档
- 耗：3–5d

### P3.8 refactor(agent-core): delete services/ barrel + verify

- 改：
  - `packages/agent-core/src/services/`（delete，已空）
  - `packages/agent-core/src/index.ts`（移除 services barrel export）
- 实现：
  - `services/` 已空（所有 domain 迁完），删除。
  - `index.ts` 不再 export services barrel；改为 export 各 domain barrel。
- 测：typecheck green；全套 test green；`services/` 不存在。
- 验：`ls packages/agent-core/src/services` 不存在；`grep "from ['\"][^'\"]*?/services" packages` 0 命中。
- 依：P3.7
- 源：PLAN §2.1
- 耗：0.5d

**P3 acceptance：** `services/` 消失；所有现有 domain 迁到 `agent-core/<domain>/`；import 全部更新；P4 / P5 可启动。

---

## P4 · domain 拆分（→ 20）（10–15d）

> 前置：P3 现有 domain 迁到新结构。本阶段把大的 domain 拆成 di-v3 的 20 个细粒度 domain。
> 每个新 domain：契约 + 厚实现 + scope 标注 + 工具（如有）+ 概念定稿。

### P4.1 refactor(agent-core): extract Cron domain

- 改：
  - `packages/agent-core/src/cron/`（new，从 `agent/cron/` + `tools/cron/` 合并）
  - `packages/agent-core/src/agent/cron/`（delete）
  - `packages/agent-core/src/tools/cron/`（delete）
  - import 更新
- 实现：
  - 把 `agent/cron/`（ICronService + CronManager）+ `tools/cron/`（scheduler / persist / clock / jitter / 3 个 cron 工具）合并到 `cron/`。
  - `cron/cron.ts`（ICronService）+ `cron/cronService.ts`（厚实现，CronManager 改名）+ `cron/scheduler.ts` + `cron/persist.ts` + `cron/expr.ts` + `cron/jitter.ts` + `cron/clock.ts` + `cron/fireXml.ts` + `cron/tools/`（CronCreate / CronList / CronDelete）。
  - `ICronService` 标 Agent scope（per main agent；sub-agent ctor no-op）。
  - 写 `registerCronTools(accessor)`。
  - 概念定稿 `.agents/skills/service-skill/explanation/domains/cron.md`（从 M4.6 task.md 拆出）。
- 测：cron 行为不变；3 个 cron 工具注册正常。
- 验：全套 test green；`grep "agent/cron\|tools/cron" packages` 0 命中。
- 依：P3.8
- 源：`kimi-code-dev-2/plan/2026.06.22-Cron-Domain.md`
- 耗：2d

### P4.2 refactor(agent-core): extract Background domain

- 改：
  - `packages/agent-core/src/background/`（new，从 `agent/background/` + `tools/background/` 合并）
  - `packages/agent-core/src/agent/background/`（delete）
  - `packages/agent-core/src/tools/background/`（delete）
  - import 更新
- 实现：
  - 把 `agent/background/`（IBackgroundService + BackgroundManager + 3 种 task）+ `tools/background/`（3 个 task 工具 + format）合并到 `background/`。
  - `background/background.ts` + `background/backgroundService.ts` + `background/task.ts`（基类）+ `background/processTask.ts` + `background/agentTask.ts` + `background/questionTask.ts` + `background/persist.ts` + `background/tools/`。
  - `IBackgroundService` 标 Agent scope。
  - 写 `registerBackgroundTools(accessor)`。
  - 概念定稿 `background.md`（从 task.md 拆出）。
- 测：background 行为不变；3 个 task 工具注册正常。
- 验：全套 test green；`grep "agent/background\|tools/background" packages` 0 命中。
- 依：P4.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Background-Domain.md`
- 耗：2d

### P4.3 refactor(agent-core): extract Goal domain

- 改：
  - `packages/agent-core/src/goal/`（new，从 `agent/goal/` + `tools/builtin/goal/` 合并）
  - `packages/agent-core/src/agent/goal/`（delete）
  - `packages/agent-core/src/tools/builtin/goal/`（delete）
  - import 更新
- 实现：
  - 把 `agent/goal/`（IGoalService + GoalMode）+ `tools/builtin/goal/`（4 个 goal 工具）合并到 `goal/`。
  - `goal/goal.ts` + `goal/goalService.ts` + `goal/budget.ts` + `goal/actor.ts` + `goal/injector.ts` + `goal/outcomePrompts.ts` + `goal/tools/`。
  - `IGoalService` 标 Agent scope。
  - 写 `registerGoalTools(accessor)`。
  - 概念定稿 `goal.md`（从 task.md 拆出）。
- 测：goal 行为不变；4 个 goal 工具注册正常。
- 验：全套 test green；`grep "agent/goal\|tools/builtin/goal" packages` 0 命中。
- 依：P4.2
- 源：`kimi-code-dev-2/plan/2026.06.22-Goal-Domain.md`
- 耗：1.5d

### P4.4 refactor(agent-core): extract Swarm domain

- 改：
  - `packages/agent-core/src/swarm/`（new，从 `agent/swarm/` + `tools/builtin/collaboration/agent-swarm.ts` 合并）
  - `packages/agent-core/src/agent/swarm/`（delete）
  - `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts`（delete）
  - import 更新
- 实现：
  - 把 `agent/swarm/`（ISwarmService + SwarmMode）+ `agent-swarm.ts` 工具合并到 `swarm/`。
  - `swarm/swarm.ts` + `swarm/swarmService.ts` + `swarm/injector.ts` + `swarm/batch.ts` + `swarm/tools/`。
  - `ISwarmService` 标 Agent scope。
  - 写 `registerSwarmTools(accessor)`。
  - 概念定稿 `swarm.md`。
- 测：swarm 行为不变；AgentSwarmTool 注册正常。
- 验：全套 test green；`grep "agent/swarm\|agent-swarm" packages` 0 命中。
- 依：P4.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Swarm-Domain.md`
- 耗：1.5d

### P4.5 refactor(agent-core): extract Records domain

- 改：
  - `packages/agent-core/src/records/`（new，从 `agent/records/` + `agent/replay/` 合并）
  - `packages/agent-core/src/agent/records/`（delete）
  - `packages/agent-core/src/agent/replay/`（delete）
  - import 更新
- 实现：
  - 把 `agent/records/`（IRecordsService + RecordsService + BlobStore）+ `agent/replay/`（IReplayService + ReplayBuilder）合并到 `records/`。
  - `records/records.ts` + `records/recordsService.ts` + `records/replay.ts` + `records/replayService.ts` + `records/types.ts` + `records/persistence.ts` + `records/blobStore.ts`。
  - `IRecordsService` / `IReplayService` 标 Agent scope；BlobStore 绑 `<agentHomedir>/blobs/`。
  - 概念定稿 `records.md`。
- 测：records / replay 行为不变。
- 验：全套 test green；`grep "agent/records\|agent/replay" packages` 0 命中。
- 依：P4.4
- 源：`kimi-code-dev-2/plan/2026.06.22-Records-Domain.md`
- 耗：1.5d

### P4.6 refactor(agent-core): extract Context domain

- 改：
  - `packages/agent-core/src/context/`（new，从 `agent/context/` + `agent/compaction/` + `agent/injection/` 合并）
  - `packages/agent-core/src/agent/context/`（delete）
  - `packages/agent-core/src/agent/compaction/`（delete）
  - `packages/agent-core/src/agent/injection/`（delete，injector 散到各源域）
  - import 更新
- 实现：
  - 把 `agent/context/`（IContextService + ContextMemory + Projector）+ `agent/compaction/`（ICompactionService + Full/Micro）+ `agent/injection/`（IInjectionService orchestrator）合并到 `context/`。
  - `context/contextMemory.ts` + `context/contextMemoryService.ts` + `context/projector.ts` + `context/notificationXml.ts` + `context/compaction.ts` + `context/compactionService.ts` + `context/fullCompaction.ts` + `context/microCompaction.ts` + `context/compactionStrategy.ts` + `context/renderMessages.ts` + `context/injection.ts` + `context/injectionService.ts` + `context/injector.ts`。
  - 三个 service（IContextMemoryService / ICompactionService / IInjectionService）标 Agent scope。
  - 具体 injector（GoalInjector / PlanModeInjector / TodoListReminderInjector / SwarmInjector / PluginSessionStartInjector）散到各源域，self-register。
  - 概念定稿 `context.md`（从 M4.4 message-context.md 拆出）。
- 测：context / compaction / injection 行为不变。
- 验：全套 test green；`grep "agent/context\|agent/compaction\|agent/injection" packages` 0 命中。
- 依：P4.5
- 源：`kimi-code-dev-2/plan/2026.06.22-Context-Domain.md`
- 耗：2d

### P4.7 refactor(agent-core): extract Todo domain

- 改：
  - `packages/agent-core/src/todo/`（new，从 `tools/builtin/state/todo-list.ts` + `agent/injection/todo-list.ts` 合并）
  - `packages/agent-core/src/tools/builtin/state/todo-list.ts`（delete）
  - `packages/agent-core/src/agent/injection/todo-list.ts`（delete）
  - import 更新
- 实现：
  - 把 `todo-list.ts`（TodoList state + 工具）+ `todo-list.ts` injector 合并到 `todo/`。
  - `todo/todo.ts`（ITodoService）+ `todo/todoService.ts`（TodoList state）+ `todo/injector.ts`（TodoListReminderInjector）+ `todo/render.ts` + `todo/tools/todoList.ts`。
  - `ITodoService` 标 Agent scope。
  - 写 `registerTodoTools(accessor)`。
  - 概念定稿 `todo.md`。
- 测：todo 行为不变；TodoListTool 注册正常。
- 验：全套 test green；`grep "todo-list" packages` 0 命中。
- 依：P4.6
- 源：`kimi-code-dev-2/plan/2026.06.22-Todo-Domain.md`
- 耗：1d

### P4.8 refactor(agent-core): extract Web domain

- 改：
  - `packages/agent-core/src/web/`（new，从 `tools/builtin/web/` + `tools/providers/` 合并）
  - `packages/agent-core/src/tools/builtin/web/`（delete）
  - `packages/agent-core/src/tools/providers/`（delete）
  - import 更新
- 实现：
  - 把 `tools/builtin/web/`（FetchURL / WebSearch 工具）+ `tools/providers/`（local / moonshot fetch-url / moonshot web-search）合并到 `web/`。
  - `web/fetcher.ts`（IUrlFetcherProviderService）+ `web/webSearch.ts`（IWebSearchProviderService）+ `web/providers/`（localFetchUrl / moonshotFetchUrl / moonshotWebSearch）+ `web/tools/`（fetchUrl / webSearch）。
  - 两个 service 标 Core scope（provider 实例也 Core scope）。
  - 写 `registerWebTools(accessor)`。
  - 概念定稿 `web.md`。
- 测：web 行为不变；2 个 web 工具注册正常。
- 验：全套 test green；`grep "tools/builtin/web\|tools/providers" packages` 0 命中。
- 依：P4.7
- 源：`kimi-code-dev-2/plan/2026.06.22-Web-Domain.md`
- 耗：1.5d

### P4.9 refactor(agent-core): extract Hook + Profile + Permission + Kosong + Kaos + Loop domain 收尾

- 改：
  - `packages/agent-core/src/hook/`（new or extend）
  - `packages/agent-core/src/profile/`（extend）
  - `packages/agent-core/src/permission/`（extend）
  - `packages/agent-core/src/kosong/`（new）
  - `packages/agent-core/src/kaos/`（new）
  - `packages/agent-core/src/loop/`（extend）
  - import 更新
- 实现：
  - Hook：从 `session/hooks/` 抽到 `hook/`（IHookRegistry / IHookEngine / IHookRunnerService）。
  - Profile：从 `profile/` + `agent/profile/` + `agent/config/`（profileRef 部分）整合到 `profile/`（IProfileLoaderService / IProfileResolverService / IProfileCatalogService / ISystemPromptRendererService / IAgentProfileService）。
  - Permission：从 `agent/permission/` + `agent/plan/` + `services/approval/` + `services/question/` 整合到 `permission/`（IPermissionRegistry / IPermissionPolicyChain / IApprovalService / IQuestionService / IAgentModeService / PlanMode）。
  - Kosong：从 `services/modelCatalog/` + `services/oauth/` + `services/auth/` + `agent/usage/` + `agent/turn/kosong-llm.ts` + `session/provider-manager.ts` 整合到 `kosong/`（IModelCatalogService / IChatProviderService / IModelAuthService / ITokenizerService / IUsageHistoryService / ISessionUsageView / IAgentModelSelectionService / KosongLLM）。
  - Kaos：从 `services/fs/` + `services/terminal/`（P3.5 已迁 kaos/terminal）+ `services/environment/` + `tools/builtin/{shell,file}` + `tools/policies/path-access.ts` 整合到 `kaos/`（IKaosRegistryService / IExecutionScope / IPathSafetyService / IFsService / IProcessService / ITerminalService + Kaos 工具）。
  - Loop：从 `loop/` + `agent/turn/` + `agent/tool/` + `services/task/` + `services/tool/` + `services/message/` 整合到 `loop/`（ITurnService / IToolService / TurnFlow / ToolScheduler / TranscriptSink / LiveEventBus）。
  - 每个 domain 独立验证；概念定稿。
- 测：每个 domain 行为不变。
- 验：全套 test green；import 全部更新。
- 依：P4.8
- 源：各 di-v3 domain 文档
- 耗：3–5d

**P4 acceptance：** 20 个 domain 全部就位；每个有契约 + 厚实现 + scope 标注 + 工具（如有）+ 概念定稿；P5 / P6 可启动。

---

## P5 · 工具按域注册（5–8d）

> 前置：P3 / P4 domain 目录迁移 + 拆分完成。本阶段把工具注册从集中式改为按域 `register<Domain>Tools`。

### P5.1 feat(agent-core): registerKaosTools + registerWebTools

- 改：
  - `packages/agent-core/src/kaos/index.ts`（extend，registerKaosTools）
  - `packages/agent-core/src/web/index.ts`（extend，registerWebTools）
  - `packages/agent-core/src/bootstrap.ts`（new，registerAllBuiltinTools）
- 实现：
  - `registerKaosTools(accessor)`：注册 Bash / Read / Write / Edit / Glob / Grep / ReadMediaFile 工具到 IToolService。
  - `registerWebTools(accessor)`：注册 FetchURL / WebSearch 工具。
  - `bootstrap.ts::registerAllBuiltinTools(accessor)`：调所有 register*Tools。
- 测：Kaos / Web 工具注册正常；IToolService 列出所有工具。
- 验：全套 test green。
- 依：P4
- 源：`kimi-code-dev-2/plan/2026.06.22-agent-core-Refactor-Overview.md` §六
- 耗：1d

### P5.2 feat(agent-core): registerCronTools + registerBackgroundTools + registerGoalTools

- 改：
  - `packages/agent-core/src/cron/index.ts`（registerCronTools）
  - `packages/agent-core/src/background/index.ts`（registerBackgroundTools）
  - `packages/agent-core/src/goal/index.ts`（registerGoalTools）
  - `packages/agent-core/src/bootstrap.ts`（extend）
- 实现：
  - `registerCronTools`：CronCreate / CronList / CronDelete。
  - `registerBackgroundTools`：TaskList / TaskOutput / TaskStop。
  - `registerGoalTools`：CreateGoal / GetGoal / UpdateGoal / SetGoalBudget。
- 测：3 域工具注册正常。
- 验：全套 test green。
- 依：P5.1
- 源：各 domain 文档
- 耗：1d

### P5.3 feat(agent-core): registerSwarmTools + registerAgentTools + registerPermissionTools

- 改：
  - `packages/agent-core/src/swarm/index.ts`（registerSwarmTools）
  - `packages/agent-core/src/agent/index.ts`（registerAgentTools）
  - `packages/agent-core/src/permission/index.ts`（registerPermissionTools）
  - `packages/agent-core/src/bootstrap.ts`（extend）
- 实现：
  - `registerSwarmTools`：AgentSwarmTool。
  - `registerAgentTools`：AgentTool（spawn single subagent）。
  - `registerPermissionTools`：EnterPlanMode / ExitPlanMode / AskUserQuestion。
- 测：3 域工具注册正常。
- 验：全套 test green。
- 依：P5.2
- 源：各 domain 文档
- 耗：1d

### P5.4 feat(agent-core): registerSkillTools + registerMcpTools + registerTodoTools

- 改：
  - `packages/agent-core/src/skill/index.ts`（registerSkillTools）
  - `packages/agent-core/src/mcp/index.ts`（registerMcpTools）
  - `packages/agent-core/src/todo/index.ts`（registerTodoTools）
  - `packages/agent-core/src/bootstrap.ts`（extend）
- 实现：
  - `registerSkillTools`：SkillTool。
  - `registerMcpTools`：createMcpAuthTool factory。
  - `registerTodoTools`：TodoListTool。
- 测：3 域工具注册正常。
- 验：全套 test green。
- 依：P5.3
- 源：各 domain 文档
- 耗：1d

### P5.5 refactor(agent-core): delete centralized tools/ registration

- 改：
  - `packages/agent-core/src/tools/`（delete，已空）
  - `packages/agent-core/src/tools/support/services.ts`（ToolServices bag → loop/toolServices.ts）
  - import 更新
- 实现：
  - `tools/` 已空（所有工具搬到各域），删除。
  - `tools/support/services.ts`（ToolServices bag）搬到 `loop/toolServices.ts`。
  - 工具注册的唯一入口是 `bootstrap.ts::registerAllBuiltinTools`。
- 测：typecheck green；全套 test green；`tools/` 不存在。
- 验：`ls packages/agent-core/src/tools` 不存在；`grep "from ['\"][^'\"]*?/tools/" packages/agent-core/src` 0 命中。
- 依：P5.4
- 源：PLAN §2.4
- 耗：1d

**P5 acceptance：** 所有工具按域注册；`registerAllBuiltinTools` 是唯一入口；集中式 `tools/` 消失；P6 / P7 可启动。

---

## P6 · service scope 标注（8–12d）

> 前置：P1 scope 机制 + P3 / P4 domain 就位。本阶段把每个 service 从 registerSingleton 迁到 registerScopedService，标注 scope，注入 I*Context。

### P6.1 refactor(agent-core): Core scope services 迁移

- 改：
  - 所有 Core scope service 的 `registerSingleton` → `registerScopedService(Core, ...)`
  - 对应 import 更新
- 实现：
  - Core scope service（IModelCatalogService / IChatProviderService / IModelAuthService / ITokenizerService / IUsageHistoryService / IKaosRegistryService / IPathSafetyService / IFsService / IProcessService / ITerminalService / IPermissionRegistry / IPermissionPolicyChain / IPermissionProfileService / IPermissionRuleService / IPermissionService / IPermissionAuditService / IShellCommandClassifier / IWorkspaceRegistryService / IWorkspaceBrowserService / IWorkspaceGitContextService / IMcpRegistryService / IMcpCredentialStore / ISkillScannerService / ISkillParserService / ISkillCatalogService / IPluginStore / IPluginSourceResolverService / IPluginArchiveService / IPluginManifestService / IPluginManagerService / IProfileLoaderService / IProfileResolverService / IProfileCatalogService / ISystemPromptRendererService / IHookRegistry / IUrlFetcherProviderService / IWebSearchProviderService / ILogService / IEventService / ICoreRuntime / IToolService / ITranscriptSink / IRestorableRegistry / ISessionLifecycleService / ISessionRepository / ISessionIndex / ISessionService / ISessionQueryService / ISessionExportService / ISessionTranscriptService / IConfigService / IMessageService / IPromptService / IAuthSummaryService / IOAuthService / IEnvironmentService / IFileStore / ITerminalService / etc.）从 `registerSingleton` 迁到 `registerScopedService(Core, ...)`。
  - `registerScopedService(Core, ...)` 是 `registerSingleton` 的别名（P1.1），行为不变。
- 测：每个 Core service 通过 registerScopedService 注册 + 解析 + 行为不变。
- 验：全套 test green。
- 依：P1, P3, P4
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §3
- 耗：2–3d

### P6.2 refactor(agent-core): Session scope services 迁移

- 改：
  - 所有 Session scope service 的 `registerSingleton` → `registerScopedService(Session, ...)`
  - ctor 注入 `ISessionContext`
  - 对应 import 更新
- 实现：
  - Session scope service（ISessionRuntimeService / ISessionPromptService / ISessionMetaService / IApprovalService / ISessionGrantStore / IQuestionService / IMcpConnectionManagerService / IMcpOAuthService / ISessionSkillRegistry / IWorkspaceService / ISessionLogService / IHookEngine / IHookRunnerService / ISessionUsageView / ITranscriptSink / ILiveEventBus / etc.）从 `registerSingleton` 迁到 `registerScopedService(Session, ...)`。
  - ctor 注入 `ISessionContext`（取 sessionId / abortSignal / executionScope），方法签名去掉 sessionId。
  - ScopeBuilder.build(Session) 注入 ISessionContext。
- 测：每个 Session service 通过 registerScopedService 注册 + 注入 ISessionContext + 行为不变。
- 验：全套 test green。
- 依：P6.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §4
- 耗：2–3d

### P6.3 refactor(agent-core): Agent scope services 迁移

- 改：
  - 所有 Agent scope service 的 `registerSingleton` / `perAgentServices.set` → `registerScopedService(Agent, ...)`
  - ctor 注入 `IAgentContext`
  - 对应 import 更新
- 实现：
  - Agent scope service（IAgentStatus / ISubagentHostService / IAgentProfileService / ICronService / IBackgroundService / IGoalService / ISwarmService / IRecordsService / IReplayService / IContextMemoryService / ICompactionService / IInjectionService / ITodoService / ITurnService / IAgentModeService / IAgentModelSelectionService / ISkillActivatorService / IPermissionManager / PlanMode / SwarmMode / GoalMode / BackgroundManager / CronManager / Compaction / AgentRecords / UsageView / TurnFlow / ToolManager / ConfigState / ContextMemory / etc.）从 `registerSingleton` / `perAgentServices.set` 迁到 `registerScopedService(Agent, ...)`。
  - ctor 注入 `IAgentContext`（取 agentId / parentId / abortSignal / executionScope），方法签名去掉 agentId。
  - ScopeBuilder.build(Agent) 注入 IAgentContext。
- 测：每个 Agent service 通过 registerScopedService 注册 + 注入 IAgentContext + 行为不变。
- 验：全套 test green。
- 依：P6.2
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §4
- 耗：3–4d

### P6.4 refactor(agent-core): Turn scope services 迁移

- 改：
  - 所有 Turn scope service 的 `registerSingleton` → `registerScopedService(Turn, ...)`
  - ctor 注入 `ITurnContext`
  - 对应 import 更新
- 实现：
  - Turn scope service（ActiveTurn / TurnHandle / AbortController / LLM stream / KosongLLM / ProviderRequestAuth / ExecutionScope / once/turn grants / per-turn LiveEventBus / ITurnGrantStore / etc.）从 `registerSingleton` 迁到 `registerScopedService(Turn, ...)`。
  - ctor 注入 `ITurnContext`（取 turnId / parentId / abortSignal / executionScope），方法签名去掉 turnId。
  - ScopeBuilder.build(Turn) 注入 ITurnContext。
- 测：每个 Turn service 通过 registerScopedService 注册 + 注入 ITurnContext + 行为不变。
- 验：全套 test green。
- 依：P6.3
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §4
- 耗：2–3d

### P6.5 refactor(agent-core): ToolCall scope services 迁移

- 改：
  - 所有 ToolCall scope service 的 `registerSingleton` → `registerScopedService(ToolCall, ...)`
  - ctor 注入 `IToolCallContext`
  - 对应 import 更新
- 实现：
  - ToolCall scope service（once grant / prepare buffer / single approval prompt handle / child AbortController / IToolCallScheduler / etc.）从 `registerSingleton` 迁到 `registerScopedService(ToolCall, ...)`。
  - ctor 注入 `IToolCallContext`（取 toolCallId / parentId / abortSignal / executionScope），方法签名去掉 toolCallId。
  - ScopeBuilder.build(ToolCall) 注入 IToolCallContext。
- 测：每个 ToolCall service 通过 registerScopedService 注册 + 注入 IToolCallContext + 行为不变。
- 验：全套 test green。
- 依：P6.4
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §4
- 耗：1–2d

### P6.6 refactor(agent-core): 删除 registerSingleton + perAgentServices

- 改：
  - 所有 service 已迁到 registerScopedService；删除 `registerSingleton`（或保留为 registerScopedService(Core, ...) 的别名）
  - `AgentFactory.buildServiceCollection` 的 `perAgentServices.set(...)` 删除（Agent scope service 已通过 registerScopedService 注册）
  - import 更新
- 实现：
  - 所有 service 通过 registerScopedService 注册后，`registerSingleton` 成为 registerScopedService(Core, ...) 的别名（P1.1）。
  - `AgentFactory.buildServiceCollection` 不再手工 `perAgentServices.set(...)`；Agent scope service 通过 registerScopedService(Agent, ...) 自动注册到 ScopeRegistry，由 ScopeBuilder.build(Agent) 装配。
  - `AgentFactory` 简化为调用 ScopeBuilder.build(Agent)。
- 测：typecheck green；全套 test green；`grep "perAgentServices.set" packages/agent-core/src` 0 命中。
- 验：全套 test green。
- 依：P6.5
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §3
- 耗：1d

**P6 acceptance：** 所有 service 标注 scope 并通过 registerScopedService 注册；I*Context 注入到位；registerSingleton / perAgentServices 删除；P7 / P8 可启动。

---

## P7 · Agent 收窄（3–5d）

> 前置：P4 domain 拆分 + P6 scope 标注完成。本阶段把 Agent 瘦到 3–4 服务，剩余职责拆到 domain。

### P7.1 refactor(agent-core): Agent 收窄到 IAgentLifecycleService + IAgentStatus + IRestorableRegistry + ISubagentHostService

- 改：
  - `packages/agent-core/src/agent/index.ts`（收窄）
  - `packages/agent-core/src/agent/lifecycle.ts`（IAgentLifecycleService + impl）
  - `packages/agent-core/src/agent/status.ts`（IAgentStatus，derived event source）
  - `packages/agent-core/src/agent/restorable.ts`（IRestorableRegistry + impl）
  - `packages/agent-core/src/agent/subagentHost.ts`（ISubagentHostService + impl）
  - `packages/agent-core/src/agent/tools/agent.ts`（AgentTool）
  - import 更新
- 实现：
  - Agent 收窄到 4 个服务：IAgentLifecycleService（manager，住 Session scope）/ IAgentStatus（derived event source，住 Agent scope）/ IRestorableRegistry（住 Agent scope）/ ISubagentHostService（住 Agent scope）+ AgentTool。
  - 剩余职责（generate / llm → Kosong 域的 IAgentModelSelectionService；rpcMethods → Loop 域；resume → Records 域的 IReplayService；useProfile → Profile 域的 IAgentProfileService；emitStatusUpdated → IAgentStatus；emitEvent → IDomainEventBus）拆到对应 domain。
  - Agent 类只保留：type / id / 4 个服务句柄 / emitEvent（委托 IDomainEventBus）/ AgentTool。
- 测：Agent 收窄后行为不变；server-e2e 0 diff（如可跑）。
- 验：全套 test green。
- 依：P4, P6
- 源：`kimi-code-dev-2/plan/2026.06.22-Agent-Domain.md`
- 耗：2–3d

### P7.2 refactor(agent-core): AgentFactory → AgentScopeBuilder

- 改：
  - `packages/agent-core/src/agent/factory.ts`（delete or simplify）
  - `packages/agent-core/src/scope/builder.ts`（AgentScopeBuilder）
  - import 更新
- 实现：
  - `AgentFactory` 简化为调用 `AgentScopeBuilder.build(parentScope, options)`。
  - AgentScopeBuilder 装配 Agent scope service（通过 registerScopedService(Agent, ...)）+ 注入 IAgentContext。
  - Agent 构造通过 AgentScopeBuilder。
- 测：Agent 构造行为不变；subagent / replay 路径不变。
- 验：全套 test green。
- 依：P7.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Scope-Mechanism.md` §5
- 耗：1d

### P7.3 refactor(agent-core): Agent slim final cleanup

- 改：
  - `packages/agent-core/src/agent/index.ts`（delete dead code）
- 实现：
  - 删除 Agent 收窄后的 dead code（已无用的 import / private method / field）。
  - 确认 Agent 公开句柄行为不变。
- 测：Agent 公开句柄行为不变。
- 验：全套 test green。
- 依：P7.2
- 源：M2.8
- 耗：0.5d

**P7 acceptance：** Agent 收窄到 3–4 服务；AgentFactory → AgentScopeBuilder；Agent 公开句柄行为不变；P8 可启动。

---

## P8 · bootstrap 生命周期（3–5d）

> 前置：P6 scope 标注 + P7 Agent 收窄完成。本阶段落地 5 阶段启动 + shutdown 反向链 + Restorable resume。

### P8.1 feat(agent-core): bootstrap 5 阶段启动

- 改：
  - `packages/agent-core/src/bootstrap.ts`（extend，5 阶段）
  - `packages/server/src/start.ts`（对接 5 阶段）
- 实现：
  - 5 阶段：① Pre-DI（import 触发 registerScopedService side effects）；② Core Build（startServer 建 ServiceCollection + new InstantiationService）；③ Listener Ready（registerAllBuiltinTools + app.ready + app.listen + process.started）；④ Serve；⑤ Shutdown。
  - `registerAllBuiltinTools` 必须在 `app.listen()` 前。
- 测：启动 5 阶段顺序正确；工具注册在 listen 前。
- 验：全套 test green；server 启动正常。
- 依：P5, P6
- 源：`kimi-code-dev-2/plan/2026.06.22-Bootstrap-Lifecycle.md` §1–5
- 耗：1.5d

### P8.2 feat(agent-core): shutdown 反向链

- 改：
  - `packages/agent-core/src/bootstrap.ts`（extend，shutdown）
  - `packages/server/src/start.ts`（对接 shutdown）
- 实现：
  - shutdown 反向链：stop accepting（app.close 开始）→ await ISessionLifecycleService.dispose()（sessions 串行 dispose）→ await coreScope.dispose()（DI 反向依赖 teardown）→ await app.close() → lockHandle.release() → process.exit(0)。
  - 每个 dispose 步骤 30s hard timeout；timeout 时 process.exit(1) + panic log。
  - lockfile release 是最后一步。
- 测：shutdown 反向链顺序正确；timeout 处理正确。
- 验：全套 test green；server shutdown 正常。
- 依：P8.1
- 源：`kimi-code-dev-2/plan/2026.06.22-Bootstrap-Lifecycle.md` §6
- 耗：1d

### P8.3 feat(agent-core): Restorable resume

- 改：
  - `packages/agent-core/src/agent/restorable.ts`（IRestorableRegistry + impl）
  - `packages/agent-core/src/records/recordsService.ts`（IRecordsService.openSnapshot + registerRecordHandler）
  - `packages/agent-core/src/bootstrap.ts`（resume chain）
- 实现：
  - resume 完全 on-demand（无 process-level daemon，无启动时 auto-restore）。
  - resume chain：ISessionLifecycleService.open → AgentScopeBuilder.build → forceEagerPerAgentServices(accessor)（触发每个 per-agent service ctor registerRecordHandler + cron/background catchup）→ IRecordsService.openSnapshot → IRestorableRegistry.restoreAll(stream)（per-record-type dispatch，god-switch restoreAgentRecord 拆成 per-service handler）→ onDidCreateAgent。
  - record.type ↔ handler 一对一（duplicate 注册 throw；missing handler auto-skip + warn）。
  - sub-agent 不 auto-resume（v1）。
- 测：resume chain 顺序正确；per-record-type dispatch 正确；fatal vs recoverable 处理正确。
- 验：全套 test green。
- 依：P8.2
- 源：`kimi-code-dev-2/plan/2026.06.22-Restorable-Lifecycle.md`
- 耗：1.5d

**P8 acceptance：** 5 阶段启动 + shutdown 反向链 + Restorable resume 就位；P9 可启动。

---

## P9 · 收尾 + 文档（2–3d）

> 前置：P1–P8 完成。本阶段删除 deprecated 结构 + 终态文档 + changeset。

### P9.1 refactor(agent-core): 终态 import 审计 + 残留清理

- 改：
  - 删除任何迁移残留的 re-export / 旧 barrel（如 P3 迁完后的 `services/` 旧 barrel）
  - 修正任何残留的 deep import
- 实现：
  - P2 / P3 迁移按新规则已不留 re-export alias；本步做最终审计，确认无残留。
  - 全量 grep 确认无旧路径 import：`grep -rEn "from ['\"][^'\"]*?/(di|base/common/event|utils|services)['\"]" packages/agent-core/src packages/agent-core/test` 0 命中。
  - 全量 grep 确认无 deep import：consumer 一律从 barrel（`#/<domain>` / `#/_base/<x>` / `#/_utils/<x>` / `@moonshot-ai/agent-core`）导入。
  - 删除 P3 迁完后可能残留的 `services/` 旧 barrel，改为通过各 domain barrel 暴露。
- 测：typecheck green；全套 test green。
- 验：上述 grep 0 命中；fence green。
- 依：P1–P8
- 源：—
- 耗：0.5d

### P9.2 refactor(agent-core): decorator 字符串改名（可选）

- 改：
  - `createDecorator('coreProcessService')` → `createDecorator('coreRuntime')`（如需）
  - 全 consumer audit + 更新
- 实现：
  - M0–M7 保留了 `'coreProcessService'` 等 decorator 字符串。本步（可选）改名。
  - 全 consumer audit + 更新（CLI / node-sdk / acp-adapter / server-e2e）。
  - 如不安全，跳过并文档化。
- 测：typecheck green；全套 test green。
- 验：全套 test green。
- 依：P9.1
- 源：M6.3 / M7.1
- 耗：1d（如做）

### P9.3 docs: 终态文档 + changeset

- 改：
  - `packages/agent-core/src/AGENTS.md`（终态 domain 布局）
  - `AGENTS.md`（Project Map）
  - `.agents/skills/service-skill/explanation/domains/`（更新各 domain 定稿）
  - `.changeset/<slug>.md`（new，minor 或 major）
- 实现：
  - 更新 `agent-core/src/AGENTS.md`：终态 domain 布局（20 个 domain）+ scope 机制 + 依赖方向 + 如何新增 domain。
  - 更新 root `AGENTS.md` Project Map。
  - 更新各 domain concept doc（与终态一致）。
  - changeset 总结 di-v3 重构。
- 测：typecheck green（无代码改动）。
- 验：阅读文档；确认终态一致。
- 依：P9.2
- 源：PLAN §2
- 耗：1d

**P9 acceptance：** deprecated 结构删除；终态文档一致；changeset 生成；di-v3 重构完成。

---

## Dependency graph

```text
P0 (地基)
 └─► P1 (scope 机制)
      ├─► P2 (基础设施下沉)
      │    └─► P3 (domain 目录迁移)
      │         ├─► P4 (domain 拆分 → 20)
      │         │    ├─► P5 (工具按域注册)
      │         │    └─► P6 (service scope 标注)
      │         │         └─► P7 (Agent 收窄)
      │         │              └─► P8 (bootstrap 生命周期)
      │         │                   └─► P9 (收尾)
```

关键路径：`P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9`。
可并行：P3 各 domain 迁移可并行；P4 各 domain 拆分可并行；P5 各 register*Tools 可并行；P6 各 scope 迁移可并行（Core / Session / Agent / Turn / ToolCall 之间）。

---

## Cross-phase standing tasks

- **doc-code 同步**：每个 phase 结束时，确认对应 domain 的 concept doc 与代码一致。
- **API snapshot 0 diff**：每个 phase 结束时跑 P0.1 的 snapshot，确认 HTTP/WS / SDK 表面未变。
- **fence 通过**：每个 phase 结束时跑 dependency-direction fence。
- **server-e2e smoke**：改动运行时 wiring 的 step（如可跑；user 已接受无 e2e 风险）。
- **无 `any` 引入**：每个 step 的 typecheck 不得新增 `any`。
- **decorator 字符串不变**：P9.2 之前禁止改 `createDecorator('...')` 字符串。
- **变更集纪律**：涉及 public API 变化的 step 需 changeset。

---

## Totals

- Step count：约 60–70（P0:3 / P1:6 / P2:6 / P3:9 / P4:9 / P5:5 / P6:6 / P7:3 / P8:3 / P9:3）
- Solo working days：约 54–81d
- 3-engineer working days：约 18–27d（P3 / P4 / P5 / P6 可并行后压缩）
- LOC estimate（added / moved / deleted）：约 15k–25k（大量是 move + split）

---

> 本 ROADMAP 的每个 step 是「建议切片」。落地前实施者需按当时仓库状态（branch、并行 refactor、server-e2e 状态、各 domain 的 concept doc 进度）再次校准；任何 step `耗 > 2d` 或无法写出 `验` 时，必须进一步拆分。
