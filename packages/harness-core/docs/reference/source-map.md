# 代码定位

Reference：写 Feature 或改文档前，先对上当前 checkout 的路径。基线是本工作区的 `packages/agent-core` 与 `packages/harness-core`，不是 `agent-core-v2` 的 `human/kernel`，也不是已改名的 `agent-core-v3`。

## 导入

| 从哪取 | 入口 |
|---|---|
| 产品符号（Feature、机器、Store、LLM） | `@moonshot-ai/agent-core` |
| Unit 原语 | `@moonshot-ai/agent-core/kernel/index` |
| XState 包装 | `@moonshot-ai/agent-core/xstate2/index` |
| harness 产品 | `@moonshot-ai/harness-core` |
| 包内互引 | `#/` → 各包 `src/*.ts` |

不要把 `#/` 抄到包外。单原语文档省略 import，以本表为准。

## agent-core

路径相对 `packages/agent-core/src/`。

| 路径 | 核对什么 |
|---|---|
| `kernel/runtime.ts` | `UnitNode`、mount / ready / cleanup、`asUnit` |
| `kernel/hooks.ts` | `provide` / `inject` / `useExpose` / `useChildren` / `useFire` / `useOn` |
| `kernel/primitives.ts` | 响应式、`createToken`、`createCollection` |
| `feature/feature.ts` | `createFeature`、`Features`、`bindHandleOn` |
| `feature/hooks.ts` | `useFeatureSlot` |
| `feature/contribution-hooks.ts` | `useAgent` / ports / `useAgentStore` |
| `app/{app,session,agent}Unit.ts` | 产品树与 Handle；`setConfig` / `setCredentialProvider` / `setRequester` |
| `agent-machine/agent.ts` | agent 机器 |
| `agent-machine/turn.ts` | turn 机器 |
| `agent-machine/tool.ts` | tool 机器 |
| `stores/agent.ts` | `AgentLogEvent`、`openAgentStore` |
| `stores/session.ts` | `SessionEvent`、`openSessionStores` |
| `store/store.ts` | `openStore` / `attach` / `dispatch` |
| `store/journal.ts` | `treeJournal`、`RecordEvent` |
| `store/blob.ts` | `Blobs` |
| `llm/message.ts` | `HistoryMessage` / `StreamedMessagePart` |
| `llm/requester/input.ts` | `LlmEvent` |
| `builtin/wait-for/`、`builtin/media/`、`builtin/provider-catalog/` | 内置 Feature |

## harness-core

路径相对 `packages/harness-core/src/`。

| 路径 | 核对什么 |
|---|---|
| `host/session.ts` | `provideSession`、`createOpenedSession`、`SessionSpace` token |
| `host/session-space.ts` | catalog：`fsSessionSpace` / `memorySessionSpace` |
| `preset.ts` | 默认 Feature 名单 |
| `features/<name>/feature.ts` | 产品 Feature |
| `feature-http/` | `createHttp`、`route-builtin` |
| `example/app.ts` | 完整装配 |

## 使用前检查

- 用符号定位最新代码，不要依赖行号。
- `runtime.ts` 还导出 `mountChild` / `handleFor` / `runUnit`，`kernel/index.ts` 不转导出它们（`asUnit` 除外）。常规代码用 `node.mount()` 和 `UnitHandle`。
- 契约变了就改对应原子文档和 [README](../README.md)。
