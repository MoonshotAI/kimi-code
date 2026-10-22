# IEventBus（eventBus）

- v2: `packages/agent-core-v2/src/app/event/eventBus.ts`（约 42 行，读 interface 与 eventBusService.ts 的 AgentEventBusView 得出；Agent 级视图，publish 自动归属当前 agent）
- 新架构: `packages/harness-core/src/composition-api/runtime.ts`（unit 树 fire/lineage 冒泡）+ `packages/harness-core/src/app/units.ts`（EventContext 富化）

## 能力对照

- [x] publish(event, agent)（Agent 级视图强制以自身上下文发布，v2 AgentEventBusView 校验 foreign context）→ agent unit 内 useFire：事件沿 agent→session→app lineage 上冒，天然以本 agent 子树为源（runtime.ts 的 deliver；hooks.ts useFire）
- [x] 事件携带 agent 归属（v2 sources WeakMap + agentDomain 事件的 agentId 校验）→ EventContext collection 富化：AgentUnit `useContribute(EventContext, { agentId })`、SessionUnit 贡献 sessionId，deliver 时合入事件（units.ts、runtime.ts）
- [x] subscribe 全量/按类（Event2Class）/按 type 三种重载 → useOn('*' | type, handler)（`packages/harness-core/src/composition-api/hooks.ts`）；宿主侧 app.on 支持 feature 前缀过滤（`packages/harness-core/src/app/app.ts`）
- [x] 仅收本 agent 事件的订阅（v2 视图的 subscribe 经 sourceOf/agentId 过滤）→ agent 级 unit 的 useOn 只收到本子树上冒事件；跨层订阅方按 event.agentId 自滤（units.ts）
- [x] 订阅随生命周期回收（v2 视图随 agent scope 销毁）→ unit 卸载即 own() 清理全部 listen（runtime.ts/hooks.ts）

## 结论

全部对齐——「Agent 级事件视图」被 unit 树的作用域与冒泡结构取代，发布归属、按型订阅与生命周期回收语义等价。
