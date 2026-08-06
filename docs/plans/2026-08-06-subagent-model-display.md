# Subagent 模型显示方案

> 设计文档，自包含。
> 目标读者：kimi-code（core/server/TUI）与 code-app（desktop/web renderer）两侧的实施者。

## 背景

subagent 的 UI 目前**完全不显示它用的是哪个模型**。随着 secondary model（`SecondaryModelPicker`）上线，subagent 可以跑在与主会话不同的模型上，用户无法从 UI 分辨某个 subagent 实际绑定的是什么。

涉及的 UI 面（apps/desktop，`apps/web` 为同步副本）：

| UI 面 | 文件 | 现状 |
|---|---|---|
| 消息流内 Agent 工具卡片 | `apps/desktop/src/renderer/components/chat/tool-calls/AgentTool.vue:53` | 标题 = 任务描述，meta 行 = `subagent_type`，无 model |
| composer 上方 dock pill → 子代理列表面板 | `ChatDock.vue:394`（pill）→ `TasksPane.vue:92`（行） | 行 = name + kind badge + timing，无 model |
| 右侧 subagent 详情面板 | `AgentDetailPanel.vue:106` | subtitle = `subagentType`，无 model |
| swarm 卡片（AgentSwarm） | `tool-calls/SwarmTool.vue` + `lib/swarmCardRows.ts` | 成员行无 model |
| TUI subagent 卡片 / swarm 面板 | `kimi-code/apps/kimi-code/src/tui/controllers/subagent-event-handler.ts` | 有 model，但仅靠 volatile 事件（见下） |

### 数据链断点

模型在 server 侧 spawn 时**已经解析完毕**，但从未进入任何对客户端可见的数据结构：

- `agentTool.ts:294` / `sessionSwarmService.ts:159` 调 `resolveSubagentBinding()`（`configSection.ts:112`）算出 `binding.model`（model alias；secondary 带 patch 字段时是派生条目 `__secondary__`）；
- 但 `emitAgentRunSpawned()` 发出的 `subagent.spawned` 事件（`mirrorAgentRun.ts:92`，wire 类型 `SubagentSpawnedEvent`）只有 `subagentId / subagentName / parentToolCallId / description / swarmIndex / runInBackground`，**没有 model**；
- 恢复路径同样没有：WS 重连快照的 roster（`snapshotSubagentSchema`，`kap-server/src/protocol/rest-snapshot.ts:61`）、REST `/tasks`（`toWireTask`，`kap-server/src/routes/tasks.ts:348`——今天连 `subagent_type` 都不带）、后台任务落盘（`SubagentTaskInfo`，`subagent-task.ts:21`）都无 model；
- 渲染端 `AppTask`（`packages/web-core/src/api/types.ts:367`）→ `TaskItem`（`types.ts:320`）/ `AgentMember`（`types.ts:131`）整条链自然都没有。

### TUI 的对照实现（仅 live）

TUI 不改协议，蹭 spawn 后 child 的 `agent.status.updated`（`emitAgentRunSpawned` 里对 child 调 `republishStatus()` 触发，带 `model` = 绑定 alias）：`subagent-event-handler.ts:123-137` 把它 patch 到 subagent 卡片，用已加载的 models catalog 做 `displayName ?? model ?? alias` 映射（`model-selector.ts:40`）；swarm 面板因成员共享一个 binding，在 header 显示一次。两个局限：

1. `agent.status.updated` 是 volatile 事件（`protocol/src/events.ts:1908`），不持久化不重放，刷新/恢复后 model 丢失；
2. spawn 到首个 status 帧之间有窗口期不显示，且 secondary 派生配置下 alias 原文是 `__secondary__`，catalog 查不到就原样露出。

本方案选择**彻底路线**：模型进入 `subagent.spawned` 事件 + 快照 + 持久化，live 与恢复后都能显示；TUI 自身也切到 spawned 事件（§4）。（初版曾在渲染端保留旧 server 的 status 帧兜底，#2679 合并 + submodule bump 后按用户决策移除，见决策 4。）

## 关键决策

0. **effort 档位显**：除 model 外同时透传 thinking effort；有具体档位（low/high/max/…）恒显，布尔态 `'on'`/`'off'`（无档位信息）不显示。server 侧取 child 的 `getEffectiveThinkingLevel()`（与 `agent.status.updated` 同一词表）。
1. **事件里带绑定 alias，不做显示名**：server 发 `model: string`（model alias）；显示名映射在客户端做（见决策 3）。alias 是稳定契约，显示名随 catalog 变化。
2. **`__secondary__` 派生条目归一化为基础 alias**：`secondary.model` 带 patch 时 `binding.model` 是合成条目 `__secondary__`（`secondaryModelOverlay.ts:43`），直接显示无意义。在 `resolveSubagentBinding` 返回值上加 `displayModel`（派生时 = 指向的基础 alias，否则 = `model`），发射事件用 `displayModel`。patch 只改 overrides（effort 等），基础 alias 足以表达"用的是哪个模型"。
3. **显示名映射在客户端**：各端用自己的 models catalog 做 `alias → displayName ?? model`，查不到回退 alias 本身（对齐 TUI `modelDisplayName` 语义）。web/desktop 新增 `lib/modelDisplay.ts`，catalog 用渲染端已有的 models 列表（Composer 的 `models` prop 同源）。
4. ~~**兼容兜底（web/desktop）**~~：**已废弃并移除**——#2679 合并且 code-app bump submodule 后，server 恒在 spawned/快照/REST 带字段，不再需要拦 `agent.status.updated` 的兼容层；`modelDisplayName` 的 `__secondary__` 哨兵隐藏（旧 server 会把原始别名透传过来）也一并移除（新 server 在 `profileService` 源头归一化）。
5. **pill 本身不动**：dock pill 是聚合计数入口（"Sub Agent (n)"），模型显示在它打开的 `TasksPane` 每一行上。
6. **model 不做降噪**：secondary-model flag 关闭时所有 subagent 恒等于主模型，每行都显示主模型名。信息准确，先不做"与主模型相同则隐藏"。（effort 按决策 0 做差异显。）

## 改动清单：kimi-code（工作克隆，非本仓 submodule）

### 1. 事件与 schema

- `packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts`
  - 本地 `SubagentSpawnedEvent`（:34）加 `readonly model?: string` 与 `readonly thinkingEffort?: string`；
  - `AgentRunSpawnedMeta`（:75）加 `readonly model?: string`；
  - `emitAgentRunSpawned`（:92）把 `meta.model` 写进事件 payload；`thinkingEffort` 在函数内直接读 child 的 `IAgentProfileService.getEffectiveThinkingLevel()`（与 `agent.status.updated` 同一词表，发射点零改动；该 child 句柄本来就被解析来调 `republishStatus`）。
- `packages/kap-server/src/protocol/events-zod.ts:803` `subagentSpawnedEventSchema` 加 `model` / `thinkingEffort` 两个 optional 字段。
- `packages/protocol/src/events.ts:786` `SubagentSpawnedEvent` 及同文件 zod schema 同步加字段。这份共享 protocol 是 TUI 类型链的源头（TUI ← node-sdk `events.ts:84` ← v1 agent-core `rpc/events.ts:30` ← `@moonshot-ai/protocol`），加上 optional 字段后 TUI 编译期即可见；v1 运行时 emit 不加该字段（见 §5），optional 不产生矛盾。

### 2. 发射点（agent-core-v2）

- `packages/agent-core-v2/src/session/subagent/configSection.ts:112` `resolveSubagentBinding` 返回值加 `displayModel`（派生条目时归一化为 `secondary.model`）；同文件新增 `subagentDisplayModel(config, flags, boundAlias)` 辅助（`__secondary__` → 基础 alias，其余原样返回），供 resume 路径与 swarm 服务使用。
- `agentTool.ts` `launch()`：`displayModel` 提升为函数级变量；新 spawn 取 `binding.displayModel`；resume 分支从 child 的 `IAgentProfileService.data().modelAlias` 读，经 `subagentDisplayModel` 归一化；`emitAgentRunSpawned`（:328）传入，并随 `SubagentHandle` 返回（供 §3 后台任务）。
- `sessionSwarmService.ts`：构造器新注入 `IConfigService` / `IFlagService`；`spawnAttempt()` 与 `resumeAttempt()` 在发射处用 `subagentDisplayModel(config, flags, binding.model)` 归一化（对已是基础 alias 的输入幂等）。
- `agentSwarmTool.ts` **不透传** `displayModel`：`binding` 只保留执行字段 `{model, thinking}`（spawn binding 是执行契约，展示名由 service 在发射时统一归一化）。
- `sessionInitService.ts:91`（AGENTS.md 生成 subagent）传 `own.modelAlias`。

### 3. 恢复路径

- **WS 快照 roster**：`subagentRosterTracker.ts:63` 条目存 `event.model`。
- **schema 单点**：`model: z.string().optional()` 加在 `taskSchema` 基座上（`kap-server/src/protocol/task.ts:16` 与镜像 `packages/protocol/src/task.ts`）——`snapshotSubagentSchema`（`rest-snapshot.ts:61`）经 `taskSchema.extend` 自动继承，快照 roster 与 REST /tasks 一处覆盖；`packages/protocol/src/rest/snapshot.ts` 镜像无需改动。
- **REST /tasks（后台/detached subagent）**：
  - `subagent-task.ts`：`SubagentTaskInfo`（:21）与 `SubagentHandle` 加 `model?`；`SubagentTask` 存并在 `toInfo`（:106）带上；唯一构造点在 `agentTool.ts`（:445，前后台都在此注册，detach 自动带上）。
  - 落盘零迁移：`PersistedTask = AgentTaskInfo`（`persist.ts:37`）整文档 JSON，新字段自动随写落盘，旧记录读取时字段缺失即为 undefined。
  - `routes/tasks.ts:348` `toWireTask` 在 `info.kind === 'agent'` 时输出 `model`。
- **state manifest 注意**：`SubagentTaskInfo` 属于 agent-core-v2 的生成式状态清单——改完必须跑 `pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest`，否则 `test/state/stateManifest.test.ts` 失败。

### 4. TUI（apps/kimi-code）

CLI/TUI 运行时已是 agent-core-v2（`apps/kimi-code/src` 不 import v1 运行时，事件经 node-sdk v2 wiring 来自 v2 event bus），§1-§2 的 spawned 字段 **live 直接可达 TUI**。改动：

- `src/tui/controllers/subagent-event-handler.ts`：
  - `handleForegroundSubagentSpawned`（:411）：`event.model` 存在时立即经 `modelDisplayName` 映射并设置——foreground 卡片 `updateSubagentMetrics({ modelDisplay, effortDisplay })`、swarm 经 `setModelDisplay` + `setEffortDisplay`。spawn 即显示，不再有窗口期，也永远拿不到 `__secondary__`（§1 已归一化）。
  - effort 差异显由 `subagentEffortDisplay()` 统一决策（undefined/'off'/与主会话相同 → 不显示），spawned 与 status 两通道共用；background 路径经 `buildBackgroundAgentMetadata` 带上 model/effort，`formatBackgroundAgentTranscript` 放进 detail 行。
  - `/tasks` 浏览器 Detail 面板（`components/dialogs/tasks-browser.ts`）：agent 任务新增 `Model:` / `Effort:` 两行——inspector 语义，显示原始 alias 与 effort 原文，**不做**差异过滤；Detail 最小高度 8→10 行容纳新增行。数据链：v2 `SubagentTaskInfo` → klient facade（`klient/src/contract/agent/rpc.ts` 的 `agentTaskInfoSchema` 加字段，否则 zod 校验剥掉）→ SDK `listBackgroundTasks`（逐字段透传）→ 组件 props；`background.task.started` 事件侧的 `TaskInfo`（protocol + kap-server events-zod + v1 `AgentBackgroundTaskInfo` 类型）同步加 optional 字段。
  - **保留** `agent.status.updated` 通道（:123-137、:514-523）：子 agent 运行中切模型的更新仍走它；同时作为 spawned 无 `model`（旧会话记录）的兜底。
- replay 不扩展：TUI replay 走 `AgentReplayRecord` 消息记录（`session-replay.ts:194`），不消费 subagent 生命周期事件，历史卡片仍无 model（与现状一致，见 §5）。

### 5. 显式不做

- v1 `agent-core/src/session/subagent-host.ts:587` 运行时 emit：CLI/TUI 已不走 v1 引擎，不动。
- TUI replay 路径：不消费 spawned 事件，历史/恢复会话的 subagent 卡片仍无 model（现状即如此；如需覆盖，replay 需先恢复 spawned 记录——单独立项）。
- `agent.status.updated` 协议不变（model 字段已存在）。

### 6. kimi-code 测试

- 更新既有断言：`agent-core-v2/test/tool/tool.test.ts`（emit 契约用例带 model）、`test/app/config/config.test.ts`（`resolveSubagentBinding` 返回值的 `toEqual` 断言补 `displayModel`）、`test/session/sessionInit/sessionInit.test.ts`、`kap-server/test/subagentRosterTracker.test.ts`、`kap-server/test/sessionEventBroadcaster.test.ts:939`、`kap-server/test/tasks.test.ts`（agent 任务带 model）。
- 新增（core/server）：`tool.test.ts` Agent 工具 spawned 信号带归一化 displayModel（harness 的 event-bus stub 记录 `publishedEvents`）；`sessionSwarm.test.ts` spawn/resume 两路径带 model + 派生条目不露出 `__secondary__`（harness 补 `IConfigService`/`IFlagService` stub——service 构造器新增了这两个依赖）。
- 新增（TUI，落 `test/tui/kimi-tui-message-flow.test.ts`，仓规不新增测试文件）：spawned 带 model 时卡片 spawn 即显示（catalog 映射友好名 / alias 兜底两例）；swarm header 同步显示；background 条目带 model；spawned 缺 model 时 `agent.status.updated` 兜底仍工作。
- 重新生成 `packages/agent-core-v2/docs/state-manifest.d.ts`（见 §3）。

## 改动清单：code-app（先 `apps/desktop` 开发，完成后同步 `apps/web`）

### 7. web-core 类型与映射

- `packages/web-core/src/api/types.ts:367` `AppTask` 加 `model?: string`（绑定 alias，非显示名）。
- `packages/web-core/src/api/daemon/wire.ts:340` `WireTask` 加 `model?: string`。
- `packages/web-core/src/api/daemon/mappers.ts:366` `toAppTask` 映射 `model: wire.model`（快照 roster 与 REST /tasks 共用此 mapper，一处覆盖两条恢复路径）。

### 8. projector

- `apps/desktop/src/renderer/api/daemon/agentEventProjector.ts:1189` `subagent.spawned` case：`model` / `thinkingEffort` 存入 `AppTask`。
- ~~旧 server 的 `agent.status.updated` 兜底~~：**已按用户决策移除**（#2679 合并 + submodule bump 后 server 恒带字段；决策 4 同此）。

### 9. UI 数据透传

- `types.ts:320` `TaskItem` 加 `model?: string`；`useKimiWebClient.ts:2370` `toUiTask` 映射。
- `types.ts:131` `AgentMember` 加 `model?: string`；`messagesToTurns.ts:252` `toAgentMember` 映射（详情面板与 swarm 行共用此函数）。
- 显示名：新增 `lib/modelDisplay.ts`（`alias → displayName ?? model → alias` 兜底）；在 `useKimiWebClient` 暴露按 agentId/toolCallId 查显示名的 provide（参考现有 `resolveAgentTaskId` inject 与 `App.vue:99` 的 `swarmMembersByToolCallId` provide 模式），注入 AgentTool / TasksPane / AgentDetailPanel / SwarmTool。

### 10. UI 展示（遵守设计系统，全部用 token，亮暗双主题验证）

- `AgentTool.vue`：meta 行 `subagentType · 模型显示名 · effort（仅差异时）`（复用现有 `.type` 样式；无 subagentType 时模型名提升为 meta 行唯一内容；model 缺失时保持现状）。
- `TasksPane.vue:92` 行内：kind badge 旁加模型显示名 + 差异 effort（muted 文本，同 `.tp-time` 层级）。
- `AgentDetailPanel.vue:106` subtitle：同上三段。
- `SwarmTool.vue`：成员共享一个 binding，参照 TUI 在概览行显示一次（第一个带 model 的成员）。
- 无新增文案，不需要新 i18n 词条（模型名是数据，分隔符复用现有 meta 行模式）。

### 11. code-app 测试与检查

- `tests/renderer/`：projector 的 spawned-model 与 status.updated 兜底用例；`toAppTask` model 映射用例；`mergeSnapshotSubagents`/`keepLiveSubagents` 不丢 model 的回归（两者都是整体保留 AppTask 字段，预期自然通过，补上断言防回归）。
- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`。

## 兼容矩阵

| server \ 客户端 | 行为 |
|---|---|
| 新 server + 新客户端 | live（spawned 事件）与恢复（快照 / REST）全路径显示 |
| 旧 server + 新客户端 | 不显示（优雅缺失，不报错）——兼容层已在合并后按决策移除 |
| 新 server + 旧客户端 | 多一个可选字段，zod/客户端均忽略，无影响 |
| 新 core + TUI | spawn 即显示；`agent.status.updated` 通道保留处理运行中切模型 |

## 验收

- kimi-code 工作克隆起 server（`KIMI_CODE_CORS_ORIGINS=... pnpm dev:server`），desktop 以 `KIMI_SERVER_URL` 联调（双仓工作流见根 `AGENTS.md`）。
- web/desktop 四个 UI 面 × {live 进行中、live 结束、页面刷新后} × 亮/暗主题，模型显示正确（含 secondary 派生配置场景显示基础 alias 的显示名）。
- 后台 subagent（`run_in_background`）detach 后、swarm 全体成员，恢复后仍有模型。
- TUI：交互会话中 Agent / AgentSwarm 调用，卡片 spawn 后即显示模型显示名（派生配置下显示基础模型的显示名而非 `__secondary__`）；`--resume` 恢复后回退现状（无 model），不报错。

## 实施顺序

1. **kimi-code PR**：§1-§6（core/server + TUI；可选字段，向后兼容，先合入；在工作克隆开发，本仓不动 submodule）。
2. **code-app PR**：§7-§11 + bump submodule 指针；按仓规跑 `changeset` skill（一律 `patch`，只写 `kimi-code-app`）；UI 改动先 desktop 后同步 `apps/web`。
