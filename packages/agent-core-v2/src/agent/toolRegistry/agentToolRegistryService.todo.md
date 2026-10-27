# IAgentToolRegistryService（agentToolRegistryService）

- v2: `packages/agent-core-v2/src/agent/toolRegistry/toolRegistry.ts`（约 29 行，读 interface 与注册表实现得出）
- 新架构: `packages/harness-core/src/runtime/agents.ts`（AgentRuntime.tools + executor）

## 能力对照

- [x] 注册/注销工具（register 返回 IDisposable）→ `packages/harness-core/src/runtime/hooks.ts` 的 `useAgentTools`（写入 `AgentRuntime.tools` 并经 `useToolHandler` 注册到执行器，onScopeDispose 自动回收）；执行器侧 `packages/agent-core/src/tool/executor.ts` 的 register 返回注销函数
- [x] 列出工具（list → ToolInfo 含披露方式）→ `packages/harness-core/src/runtime/agents.ts` 的 `syncAgentTools` 把 tools Map 同步为 `loop.setTools` 描述（含 deferred 标记，对应 v2 ToolDisclosure 的 inline/deferred）
- [x] 按名解析可执行体（resolve）→ `packages/agent-core/src/tool/executor.ts` 按名 slot 解析（未知名在带内返回 unknown tool 结果）
- [ ] 工具来源标记（ToolRegistrationOptions.source、listReferences 的 ToolReference{name, source}）— 新栈 `ToolDefinition`（`packages/agent-core/src/tool/contract.ts`）无 source 字段，按来源（builtin/mcp/user/plugin）区分工具并用于策略/审批的能力未迁

## 结论

未对齐 1 项——注册/列举/解析主面已对齐到 AgentRuntime+executor；工具来源（source）标记未迁。
