# IAgentCacheProbeService（agentCacheProbeService）

- v2: `packages/agent-core-v2/src/agent/usage/cacheProbe.ts`（约 8 行，读 interface 与 cacheProbeService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/telemetry/derive.ts`（部分承载）

## 能力对照

- [x] prompt_cache_probe 遥测（turn_id、input_tokens、input_cache_read、input_cache_creation、output_tokens）→ `packages/harness-core/src/features/telemetry/derive.ts`（useLoopEvent('llm.streaming.usage') 逐 turn 上报）+ `packages/harness-core/src/features/telemetry/events.ts`（事件定义）
- [x] probe 的触发源（v2 订阅会话用量记录流，新栈订阅 loop 的 llm.streaming.usage 事件，触发源等价存在）→ `packages/harness-core/src/features/telemetry/derive.ts`（useLoopEvent）
- [ ] fork 父子请求对比维度：v2 在 fork 场景取父 agent 的 lastTurnRequest，对比 tools_match / system_prompt_match / parent_input_tokens / parent_request_gap_ms，并带 provider_type / protocol / source='fork' — 新栈无对应，降级为基础用量字段
- [ ] 仅 fork 首个 turn 触发（v2 以 firstRecord + source.type==='turn' 门控，非 fork agent 直接不注册）— 新栈对每个 llm.streaming.usage 都上报，触发语义不同，记录在案

## 结论

未对齐 2 项——prompt_cache_probe 事件在案但只覆盖基础 cache 用量；fork 父子请求对比维度与 fork 首 turn 触发门控未迁，属降级。
