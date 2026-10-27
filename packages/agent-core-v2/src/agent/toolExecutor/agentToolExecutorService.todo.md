# IAgentToolExecutorService（agentToolExecutorService）

- v2: `packages/agent-core-v2/src/agent/toolExecutor/toolExecutor.ts`（约 68 行，读 interface 与 toolExecutorService.ts 得出）
- 新架构: `packages/agent-core/src/tool/executor.ts` + `packages/agent-core/src/loop/tool/`（tool-call 机器）

## 能力对照

- [x] 批量执行工具调用并以流式产出结果（execute(calls, options): AsyncIterable）→ loop 内 tool-call 机器逐调用驱动 `ToolExecutor.execute`，结果经 `tool.ended` 事件流出（`packages/agent-core/src/loop/contract/emitted.ts`）
- [x] 执行前/执行完成事件与钩子（onBeforeExecuteTool/onWillExecuteTool/onDidExecuteTool）→ `packages/agent-core/src/tool/contract.ts` 的 `tool.starting`/`tool.permitting`/`tool.ending` 三个 hook point 加 `tool.started`/`tool.ended` 事件
- [x] 调用裁决注册点（registerToolCallGuard）→ `tool.permitting` 钩子恒对最终改写后调用做裁决（`packages/agent-core/src/tool/executor.ts`）；不可用/未知工具文案由 `packages/agent-core/src/tool/policy.ts` 的 unavailableTool/unknownTool 加 `invalidate(name, reason)` 承载，自定义 describer 注册表未保留（文案固定）
- [x] 结果长度截断 → `packages/agent-core/src/tool/policy.ts` 的 `truncateResult`（ExecutorPolicy.maxResultChars 单层截断）
- [ ] 执行器级 truncateForModel 分级截断 — v2 `packages/agent-core-v2/src/agent/toolResultTruncation/`（服务约 344 行加契约约 26 行）按模型预算分级压缩结果未迁；50K–10M 级结果全文进 history 的问题在案，现仅有 maxResultChars 单层截断
- [ ] recordDupType(toolCallId, dupType) 标记通道 — v2 供 toolDedupe 把 same_step/cross_step 标记挂到执行器记录（随执行遥测带出 dup_type）；新栈 `packages/harness-core/src/features/toolDedupe/feature.ts` 自行检测并直接上报 `tool_call_dedup_detected` 遥测，但「dupType 附着到工具调用记录」这一通道无对应

## 结论

未对齐 2 项——执行/裁决/钩子主面已对齐到 agent-core tool+loop；分级截断（在案）与 dupType 标记通道未迁。
