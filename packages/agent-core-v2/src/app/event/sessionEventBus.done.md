# ISessionEventBus（sessionEventBus）

- v2: `packages/agent-core-v2/src/app/event/eventBus.ts`（约 42 行，读 interface 与 eventBusService.ts 的 EventBusService 得出；Session 级总线，管理 agent 激活注册表与按 agent 频道分发）
- 新架构: `packages/harness-core/src/composition-api/runtime.ts`（lineage 冒泡 + EventContext）+ `packages/harness-core/src/app/units.ts`（SessionUnit/AgentUnit 生命周期）

## 能力对照

- [x] activateAgent/deactivateAgent/isAgentActive（agent 生命周期注册表，发布与订阅的合法性基准）→ unit 挂载/卸载即激活语义：AgentUnit mount 时 fire `agent.opened`、卸载时 fire `agent.closed`（units.ts）；非激活 agent 无子树故无从发布/接收
- [x] publish(event, agent?)（按 type 分桶 + 全量 + 按 agent 频道三路分发）→ node.fire → deliver 沿 lineage 逐层派发到 type/'*' 监听器（runtime.ts）；agent 域事件经 EventContext 携带 agentId（units.ts）
- [x] sourceOf(event) 溯源发布 agent → EventContext 富化后事件自带 agentId/sessionId 字段（runtime.ts 的 deliver 合并）
- [x] subscribeAgent(agent, type?, handler)（按 agent 过滤的会话级订阅）→ 会话级 unit useOn 后按 event.agentId 过滤（runtime.ts/units.ts；agentId 由 AgentUnit 的 EventContext 贡献保证存在）
- [x] onAgent(agent, cls|type, handler)（agentDomain 事件按 agentId 过滤）→ 同上；v2 的 agentDomain 类标记由 EventContext 机制取代
- [x] 频道随 agent 停用销毁（v2 deactivateAgent dispose 频道）→ AgentUnit 卸载即清理其全部监听与上下文（runtime.ts own/useCleanup）

## 结论

全部对齐——会话级总线的激活注册、按 agent 分发与溯源能力由 unit 树生命周期 + 冒泡 + EventContext 富化等价承载。
