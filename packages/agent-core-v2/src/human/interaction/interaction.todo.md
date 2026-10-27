# Interaction 子系统（human/interaction + agent/interaction，非 DI Service）

- v2: `packages/agent-core-v2/src/human/interaction/`（interaction.ts 54 行类型 + machine.ts 88 行 xstate 登记表 + facade.ts 255 行进程单例）与 `packages/agent-core-v2/src/agent/interaction/`（interactionWiring.ts 83 行 agent 桥接 + approval/question 载荷）
- 新架构: `packages/harness-core/src/features/interaction/`（interaction.ts 的 `openInteractions` session 级登记表 + feature.ts 的 session slot 接线 + question-payload.ts）

## 说明

v2 的 Interaction 不走 `createDecorator` 注册——它是 human/ 层的进程单例模块（facade.ts 导出全局 `interactions`），agent 层经 `interactionWiring.ts` 按 `sessionId:agentId` tag 桥接进同一单例，因此不在 240 个 DI Service 盘点清单内，本文档为补录。

## 能力对照

- [x] 登记表全方法（request/enqueue/respond/findAll/findOne/wait，含 recently-resolved 60s TTL / 256 上限、id 生成规则、query matches 语义）→ `packages/harness-core/src/features/interaction/interaction.ts` 的 `openInteractions`，逐字语义
- [x] 事件 `interaction.requested` / `interaction.resolved` → session slot `useFire()` 上节点面，冒泡至 Session/App（v2 经 `IEventDispatcher` 的 `InteractionRequestEvent`/`InteractionResolvedEvent`，见 `agent/interaction/interactionOps.ts`）
- [x] 取消语义（cancelled + reason）→ `cancelAgent(agentId, 'agent_closed')`（agent 卸载）与 `stop()`（session 卸载）；v2 `detachAgent`/`purgeSession` 的 session 归属由「实例即隔离」结构承载
- [x] 订阅通知（v2 的 `onDidChangePending`/`onDidResolve`）→ 决策改为 fire 事件 + 迟到订阅者先 `findAll({ resolved: false })`
- [x] 跨 session 隔离（v2 进程单例 + tag 过滤 + attach/detachAgent）→ 决策改为 session 级实例，隔离靠实例本身，无单例
- [ ] 进程结束时清理的 `turn_ended` 取消（v2 `cancelInteractionsForTurn`：turn 结束取消该 turn 的未决请求）— 决策不做：后台 question 可跨 turn，`InteractionCancellationReason` 的 `'turn_ended'` 变体保留但无生产方
- [ ] xstate 状态机登记表（machine.ts）— 决策不用状态机（只有 pending/resolved 的 Map，无跨异步阶段）

## 关联缺口

AskUserQuestion 工具本体未迁（见 `packages/agent-core-v2/src/agent/tools/ask-user-question/askUserQuestionTool.md`）；approval/question 载荷的 UI 展示映射在 feature-http `route-features/interaction.ts` 与 feature-acp `interaction-bridge.ts` 已对齐。

## 结论

登记表机制全部对齐（进程单例 → session 级实例为定稿架构差异）；未对齐 2 项均为记录在案的决策（turn 结束不取消、不用状态机）。
