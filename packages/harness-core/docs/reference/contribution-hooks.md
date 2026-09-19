# Feature 贡献 hook

Reference：builtin 扩展点。源码 `packages/agent-core/src/feature/contribution-hooks.ts`。全部必须在同步 setup（或 `asUnit` 包住的 HTTP handler 开头）调用。卸载随当前 Unit 撤回。产品组合见 [2. Todo](../how-to-guides/02-add-todo-feature.md) 与 [8](../how-to-guides/08-develop-feature.md)。

## 命令面

| hook | 返回 | 说明 |
|---|---|---|
| `useApp()` | `AppCommands` | 活 session 表、`installFeature` |
| `useSession()` | `SessionCommands` | 活 agent 表、`stores` |
| `useAgent()` | `AgentCommands` | `config` / `setConfig` / `setCredentialProvider` / `setRequester` / `submit` / `notify` / `on`（机器事件） |

不要 `inject(AppUnitRef)` 等 token。按 id 查找不是 hook：`useApp().get(id)` / `session.get(agentId)`，失败是 `undefined`。绑 generate 用 `setConfig` / `setCredentialProvider` / `setRequester`。缺 `config` 或 requester 的下一次 `generate` 失败。

harness 另有：`useSessionSpace` / `useOpenSession` / `useCreateSession` / `useUpdateSession`（`src/host/session.ts`）。

## Store

| hook | 说明 |
|---|---|
| `useAgentStore()` | `getState` / `dispatch` / `fold(projection)` → `ShallowRef` |
| `useSessionStore()` | 同上，session journal |
| `useBlobs()` | 内容寻址仓，与 journal 平级 |

`fold` 从日志起点重放，中途安装的 Feature 也能看到历史。`dispatch` 是唯一写入口。

## Agent ports

| hook | 说明 |
|---|---|
| `useAgentTools(...tools)` | 空名 / 重名抛错。`deferred: true` 的工具不进 `getTools()`（不给模型），仍可被逻辑调用 |
| `useSystemPrompt(...sections)` | `{ id, text, priority? }`。`id` 非空、不重复、不能是 `host`。第一次 `getSystemPrompt(host)` 冻住 |
| `useMessageResolver(resolver)` | `id` 唯一。组包前改 messages |
| `useLlmRecovery(recovery)` | `propose` 返回提案或 `undefined`；先提案者胜。`credentialsRecovery` 已由 `bindAgentLogics` 前置 |
| `useLlmRetryable(fn)` | 只加不减。`true` 才生效。不能把默认可重试改成不可重试 |
| `useBeforeStep(hook)` | 每步 LLM 前。compaction 在这里抛 `CompactError` |
| `useBeforeTool(hook)` | 返回 `proceed`（可改 call）或 `denied` |
| `useAfterTool(hook)` | 可改 `ToolResult`；deny 路径也跑 |
| `usePromptGate(gate)` | host gate 先于 Feature。`true` / `{ block: true }` 拦下；可改 `message` |
| `useMediaLower(ports)` | 单槽。重复登记抛错 |
| `useWaitForTasks()` | 等后台 tool actor |

`bindPromptGate` 链式：先 block 胜出，rewrite 依次。`AgentUnit` 始终挂这条链（含空列表），以便动态安装。

## HTTP

`useHttpRoute` 用 `asUnit` 恢复 HTTP Feature 节点。handler 里同步 `inject` / `useApp`，第一次 `await` 后出栈。路由全部写在 handler 内。

## 相关文档

- 怎么组合 → [02](../how-to-guides/02-add-todo-feature.md) · [08](../how-to-guides/08-develop-feature.md)
- 模型 → [feature-model](../explanation/feature-model.md)
