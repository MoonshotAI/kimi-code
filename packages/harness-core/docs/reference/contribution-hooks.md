# Feature 贡献 hook

Reference：builtin 扩展点。源码 `packages/agent-core/src/feature/contribution-hooks.ts`。全部必须在同步 setup（或 `asUnit` 包住的 HTTP handler 开头）调用。卸载随当前 Unit 撤回。产品组合见 [2. Todo](../how-to-guides/02-add-todo-feature.md) 与 [8](../how-to-guides/08-develop-feature.md)。

## 命令面

| hook | 返回 | 说明 |
|---|---|---|
| `useApp()` | `AppCommands` | 活 session 表、`installFeature` |
| `useSession()` | `SessionCommands` | 活 agent 表、`stores` |
| `useAgent()` | `AgentCommands` | `config` / `setConfig` / `setCredentialProvider` / `setRequester` / `submit` / `notify` / `on`（机器事件） |

命令面是收窄后的 Commands——Feature 经这三个 hook 拿到提交、配置、订阅的完整能力，节点内部结构留在产品节点背后。按 id 查找走实例方法：`useApp().get(id)` / `session.get(agentId)`，失败是 `undefined`。绑 generate 用 `setConfig` / `setCredentialProvider` / `setRequester`。缺 `config` 或 requester 的下一次 `generate` 失败。

catalog 在 `useApp()` 上：`app.space` / `app.open` / `app.updateSession` / `app.delete`（删除会话：live 先 close、再 `space.delete`、完成后 app 节点 fire `session.deleted`）。未配 `space` 时访问会抛错。

## 依赖注入与清理

| hook | 返回 | 说明 |
|---|---|---|
| `useInject(token)` | certain：`T`；facade：`Readonly<ShallowRef<T \| undefined>>` | 分级语义见 [useInject](inject.md)：框架 token 缺席抛错，facade token 返回响应式可空 ref（lineage 最近、随挂载 / 卸载驱动） |
| `useCleanup(fn)` | — | 往当前 Unit 登记清理，卸载随 Unit 撤回 |

facade token 一律 `createFacadeToken`（包根导入），`useExpose` 只接受 facade token。树外取 facade 用 `handle.resolve(token)`：`resolve(CertainToken): T` 缺席抛错，`resolve(FacadeToken): T | undefined` 不抛错。

## Store

| hook | 说明 |
|---|---|
| `useAgentStore()` | `getState` / `dispatch` / `fold(projection)` → `ShallowRef` / `onCommit`（登记随当前 Unit 撤回） |
| `useSessionStore()` | 同上，session journal |
| `useBlobs()` | 内容寻址仓，与 journal 平级 |

`fold` 从日志起点重放，中途安装的 Feature 也能看到历史。`dispatch` 是唯一写入口。`onCommit` 用于派生副作用，返回 off 且已登记清理，不要直接 `useInject(AgentStoreRef)` 拿裸 store。

## Agent ports

| hook | 说明 |
|---|---|
| `useAgentTools(...tools)` | 空名 / 重名抛错。`deferred: true` 的工具不进 `getTools()`（不给模型），仍可被逻辑调用 |
| `useSystemPrompt(...sections)` | `{ id, text, priority? }`。`id` 非空、不重复、不能是 `host`。第一次 `getSystemPrompt(host)` 冻住 |
| `useMessageResolver(resolver)` | `id` 唯一。组包前改 messages |
| `useLlmRecovery(recovery)` | `propose` 返回提案或 `undefined`；先提案者胜。`credentialsRecovery` 已由 `bindAgentLogics` 前置 |
| `useLlmRetryable(fn)` | 只加不减。`true` 才生效。不能把默认可重试改成不可重试 |
| `useBeforeStep(hook)` | 每步 LLM 前。返回 `{ compact: true }` 决策让 turn 进 `compacting`（compaction 超预算走这里） |
| `useAfterStep(hook)` | 每步完成后（含自然末步，context 带 `final` 区分）。《续行边界》（工具批后）返回 `{ stopTurn: true }`（首个生效）让 turn 正常收场，否则续行 |
| `useBeforeToolBatch(hook)` | 整批一次裁决，先于一切 per-call 钩子。input 为同响应全部 `toolCalls`；返回 `denied` 则整批逐 call 否决（per-call 钩子与 executor 不再跑） |
| `useBeforeTool(hook)` | 返回 `proceed`（可改 call）或 `denied`。input 只带本 call 的 `toolCall`；批级语义走 `useBeforeToolBatch` |
| `useToolPermission(hook)` | 风险裁决阶段，恒在全部 `useBeforeTool` 之后、执行之前，看到守卫改写后的最终 call。协议同 `useBeforeTool` |
| `useAfterTool(hook)` | 可改 `ToolResult`；deny 路径也跑 |
| `usePromptGate(gate)` | host gate 先于 Feature。在 turn 内执行（`turn.started` 之后）：`true` / `{ block: true }` 拦下——原始 prompt 落 history、发 `prompt.blocked`、turn 以 `failed` 收尾；可改 `message`（改写后落盘并消费） |
| `useMediaLower(ports)` | 单槽。重复登记抛错 |
| `useWaitForTasks()` | 等后台 tool actor |

`bindPromptGate` 链式：先 block 胜出，rewrite 依次。`AgentUnit` 始终挂这条链（含空列表），以便动态安装。

## HTTP

`useHttpRoute` 用 `asUnit` 恢复 HTTP Feature 节点。handler 里同步 `useInject` / `useApp`，第一次 `await` 后出栈。路由全部写在 handler 内。

## 相关文档

- 怎么组合 → [02](../how-to-guides/02-add-todo-feature.md) · [08](../how-to-guides/08-develop-feature.md)
- 模型 → [feature-model](../explanation/feature-model.md)
