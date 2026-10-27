# IAgentToolSelectService（agentToolSelectService）

- v2: `packages/agent-core-v2/src/agent/toolSelect/toolSelect.ts`（约 42 行，读 interface 与 toolSelectService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/tool-select/`（feature + state + resolver + tool）+ `packages/agent-core/src/llm/message.ts`（ToolDescription.deferred 语义）

## 能力对照

- [x] enabled()：按模型能力（dynamically_loaded_tools + tool_use）启用 → `packages/harness-core/src/features/tool-select/state.ts`（isToolSelectEnabled）
- [x] shapeTools：deferred 工具标记下发 → `packages/harness-core/src/features/tool-select/tool.ts`（deferTool 标 deferred: true）+ `packages/agent-core/src/llm/message.ts`（deferred 字段；mcp deferred 通道复用同语义）
- [x] shapeHistory：按当前可加载态裁剪历史中的工具 schema → `packages/harness-core/src/features/tool-select/resolver.ts`（createToolSelectMessageResolver）
- [x] load：select_tools 工具加载流程 → `packages/harness-core/src/features/tool-select/tool.ts`（createSelectToolsTool）+ `packages/harness-core/src/features/tool-select/state.ts`
- [x] drainPendingToolSchemas 与 loadableToolsAnnouncement（经两个配套服务注入）→ `packages/harness-core/src/features/tool-select/feature.ts`（pushSchemas / turn.started 公告）
- [ ] load 结果分类降级：v2 区分 alreadyCallable/staleLoaded/policyDenied 并带 escalated/consecutiveFailures 失败升级与 suggestions 拼写建议 — 新栈 LoadToolsResult 只有 toLoad/alreadyAvailable/unknown 三类，升级与建议未迁
- [ ] 工具执行器描述符：v2 registerUnavailableToolDescriber/registerMissingToolDescriber 给出「未加载」「已失效」「MCP 断连」三类文案 — 新栈仅 deferTool 执行期拦截「未加载」一类，后两类未迁
- [ ] 实验 flag 门控（v2 TOOL_SELECT_FLAG_ID）— 新栈按能力直挂，flag 面未迁

## 结论

未对齐 3 项——deferred 语义、加载流程、schema 下发与公告已迁移；load 结果分类/失败升级/建议、执行器描述符后两类与 flag 门控降级或未迁。
