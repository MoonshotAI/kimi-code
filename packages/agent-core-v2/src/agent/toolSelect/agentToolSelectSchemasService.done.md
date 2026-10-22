# IAgentToolSelectSchemasService（agentToolSelectSchemasService）

- v2: `packages/agent-core-v2/src/agent/toolSelect/toolSelectSchemas.ts`（约 8 行，读 interface 与 toolSelectSchemasService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/tool-select/feature.ts`

## 能力对照

- [x] 待下发工具 schema 以 system 消息（content 空、带 tools）注入（DYNAMIC_TOOL_SCHEMA_VARIANT）→ `packages/harness-core/src/features/tool-select/feature.ts`（pushSchemas 在 tool.ended/tool.async_ended/message.appended 时把 state.pendingSchemas() 以 DYNAMIC_TOOL_SCHEMA_REMINDER_KEY remind 注入，落地后 markSchemasLanded 转入已加载集）
- [x] 排队集合维护与排序下发（pending 按名字排序逐批 drain）→ `packages/harness-core/src/features/tool-select/state.ts`（pendingSchemas 排序输出；load 时入 pending）
- [x] 在飞去重（schemaFlight 防止同批 schema 重复注入）→ `packages/harness-core/src/features/tool-select/feature.ts`（schemaFlight 标志 + queueMicrotask 注入）
- [x] 落地后转入已加载集、后续调用放行 → `packages/harness-core/src/features/tool-select/state.ts`（markSchemasLanded 由 pending 转 landed）+ `packages/harness-core/src/features/tool-select/tool.ts`（deferTool 执行期按 isLoaded 放行）

## 结论

全部对齐（schema 排队的下发、注入消息形态、在飞去重与落地确认均由 tool-select feature 承载）。
