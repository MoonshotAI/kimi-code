# HistoryMessage 与 Delta

Reference：落盘历史是 `HistoryMessage`；流式增量是 `StreamedMessagePart`（机器事件 `llm.streaming.part` 的 `part`）。源码 `packages/agent-core/src/llm/message.ts`。怎么订这两面见 [1. 跑完一个 turn](../how-to-guides/01-run-a-turn.md)。

文档里说的 Delta 就是 `StreamedMessagePart`，包内没有名为 `Delta` 的类型。

## HistoryMessage

`HistoryMessage = SystemEntry | UserEntry | AssistantEntry | ToolEntry`。每条是 `{ message, meta? }`，不是裸 `Message`。

```text
HistoryEntry<T, F> = { message: T; meta?: F }
```

| 角色 | message | meta 要点 |
|---|---|---|
| `system` | `{ role, content, tools? }` | `source` / `key` |
| `user` | `{ role, content }` | `promptId` / `origin` / `tracked` / `createdAt` |
| `assistant` | `{ role, content, toolCalls }` | `usage`（必有）/ `model` / `headers` / `finish` / `messageId` |
| `tool` | `{ role, content, toolCallId }` | `source` / `key` |

`content` 是 `ContentPart[]`：

| `type` | 字段 |
|---|---|
| `text` | `text`，可选 `contentType`（`text/plain` \| `text/markdown` \| `text/xml`）/ `meta` |
| `think` | `think`，可选 `encrypted` / `hidden` / `reasoningKey` / `detailsIndex` |
| `image_url` / `audio_url` / `video_url` | 对应 `*Url.url`，可选 `name` |

`meta.kind === 'skill'` 表示 skill 段；`meta.kind === 'reminder'` 是 system reminder。身份在 part 上，不在 `origin.skillActivations`。

`toolCalls` 只出现在 assistant：`{ type: 'function', id, name, arguments, extras?, rawId? }`。`arguments` 是 JSON 字符串或 `null`。

构造：`createUserMessage` / `createAssistantMessage` / `createToolMessage`，或 `createHistoryMessageBuilder().plain|markdown|xml|systemReminder().userMessage()`。入 journal 用 `createUserEntry(message, meta)` 等。

节点事件 `message.appended` 的字段就是 `message: HistoryMessage`。一个 turn 多条：先 assistant（`llm.done`），再本步 tool / drain（`turn.drained`）。think 与 text 在同一条 assistant 上。

## Delta（`StreamedMessagePart`）

```ts
type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart
```

`ToolCallPart`：`{ type: 'tool_call_part', argumentsPart, index? }`，用来拼已出现的 function call 的 arguments。

`agent.on('llm.streaming.part', ev => ev.part)` 每次一块增量。`mergeInPlace(target, source)` 能合并则改 `target` 并返回 `true`：

- 两个 `text`：identity 相同则拼接 `text`
- 两个 `think`：同一 `reasoningKey` / `detailsIndex` / `hidden`，且目标没有 `encrypted`
- `function` + `tool_call_part`：拼接 `arguments`

否则当作新 part。`createMessageAccumulator()` 按这个规则攒成一条 `AssistantMessage`；`llm.done` 时机器侧的 `entry` 已经是攒完的 `AssistantEntry`，并已写入 turn history。

其它流式事件（同一面，都不是 journal）：

| type | 字段 |
|---|---|
| `llm.streaming.headers` | `headers` |
| `llm.streaming.usage` | `usage` |
| `llm.streaming.finish` | `finish` |
| `llm.streaming.message_id` | `messageId` |

不要用 `session.on` 等 Delta。节点事件只有完整 `HistoryMessage`。

## 相关文档

- 跑一个 turn → [01](../how-to-guides/01-run-a-turn.md)
- 事件面 → [events](events.md)
- 占用 → `usedContextTokens(history)`（`llm/usage.ts`）
