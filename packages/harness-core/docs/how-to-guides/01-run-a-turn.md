# 1. 启动最小 App 并跑完一个 turn

How-to：用 builtin SDK 绑一个已知模型的 API，`mountApp` 开出实例，创建 agent 后 `setConfig` / `setCredentialProvider` / `setRequester`，提交一条用户 prompt，等到这个 turn 落盘结束。报文形状见 [HistoryMessage 与 Delta](../reference/history-message.md)。队列为什么存在、状态机怎么走见 [Agent 状态机](../explanation/agent-machine.md)。

这一步不装 `provider-catalog`（那是 [7](07-use-provider-catalog.md)），也不写 Feature。

## 装配

`openaiProvider` / `createStaticCredentialProvider` / `createUserMessage` / `mountApp` 来自 `@moonshot-ai/agent-core`。`memorySessionSpace` / `provideSession` / `createOpenedSession` 来自 `@moonshot-ai/harness-core`。

```ts
import {
  createStaticCredentialProvider,
  createUserMessage,
  MAIN_AGENT_ID,
  mountApp,
  openaiProvider,
  type LlmModel,
} from '@moonshot-ai/agent-core';
import { createOpenedSession, memorySessionSpace, provideSession } from '@moonshot-ai/harness-core';

const model: LlmModel = {
  provider: 'openai',
  model: 'gpt-4o',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 128_000,
  baseUrl: process.env['OPENAI_BASE_URL'],
  apiKey: process.env['OPENAI_API_KEY'],
};

const space = memorySessionSpace();
const app = mountApp({
  provide(node) {
    provideSession(node, space, { agent: { agentId: MAIN_AGENT_ID } });
  },
});
await app.ready();
```

要开 session 才注入 `SessionSpace`。`agent` 是每个 `createOpenedSession` 自动挂上的模板。最小路径不要传 `features`；要默认产品名单再写 `features: [...features]`。`config` / 凭证 / 传输不在 `mountApp` 上配，开完 agent 再 set。

Anthropic / Google 把 requester 换成 `anthropicProvider.requesters.anthropic` / `googleProvider.requesters['google-genai']`。Kimi 用 `@moonshot-ai/harness-core` 的 `kimiProvider.requesters.openai`（或 `.anthropic` / `.openai_responses`）。协议绑定细节见 [15. 绑定 Provider](15-run-llm-request.md)。按模型再绑一条见 [7. provider-catalog](07-use-provider-catalog.md)。

落盘用 `fsSessionSpace('/path/to/data-root')`。可运行闭环见 `example/app.ts` 与 `example/cli.ts`。

## 开 session、发 prompt、等结束

```ts
import type { SessionHandle } from '@moonshot-ai/agent-core';

function waitTurn(session: SessionHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = session.on('turn.ended', (event) => {
      off();
      const outcome = event['outcome'];
      if (outcome === 'done') resolve();
      else reject(new Error(String(event['errorMessage'] ?? outcome)));
    });
  });
}

const session = await createOpenedSession(app, { sessionId: 'demo' });
const agent = session.get(MAIN_AGENT_ID);
if (agent === undefined) throw new Error('agent not mounted');
agent.setConfig({ model });
agent.setCredentialProvider(createStaticCredentialProvider(model.apiKey));
agent.setRequester(openaiProvider.requesters.openai);

const finished = waitTurn(session);
agent.submit(createUserMessage('你好'), {
  promptId: 'p1',
  origin: { kind: 'user' },
  tracked: true,
});
await finished;
```

`submit` 是同步 `send`，只进机器 queue，立刻返回，**不**写 journal 的 `input.submitted`。等 UI 事实订节点事件 `turn.ended`，不要订 `agent.on('turn.done')`。本步 assistant 落盘看 `session.on('message.appended')`；一个 turn 可以有多条。

`get` 失败是 `undefined`。catalog 里有、树还没挂时也是 `undefined`（ensure-open 未做）。没有模板、或再挂一个 agent：`session.create({ agentId })`。

## 流式 Delta

Delta 不落盘，走机器事件：

```ts
const off = agent.on('llm.streaming.part', (event) => {
  if (event.part.type === 'text') process.stdout.write(event.part.text);
});
```

`part` 的类型是 `StreamedMessagePart`。攒成一条 `AssistantMessage` 用 `createMessageAccumulator()`。字段表见 [HistoryMessage 与 Delta](../reference/history-message.md)。

## 其余命令

`setConfig` / `setCredentialProvider` / `setRequester` 不进机器。其余都是同步 `send`。

| 要做什么 | 调用 | 进哪 |
|---|---|---|
| 模型 / thinking / 采样 | `setConfig(config)` | 下次 `generate` |
| 凭证 | `setCredentialProvider(provider)` | 下次 `generate` |
| 协议传输 | `setRequester(requester)` | 下次 `generate` |
| 用户 prompt（占队列、可撤/可并） | `submit(message, meta?)` | `queue` |
| 不占队列的旁路说明 | `notify(message)` | `notifications` |
| 按 key 覆盖一条 reminder | `remind(key, message)` | `reminders` |
| 丢掉还没开跑的一条 prompt | `cancel(promptId)` | 从 `queue` 删 |
| 把若干排队 prompt 合成一条通知 | `steer(id \| ids)` | 取出后当 `notify` |
| 打断当前 turn | `abort(reason?)` | `aborting` → `turn.ended` `aborted` |
| 暂停 / 继续 | `pause()` / `continue()` | 立 `paused` |

`notify` 不会单独开一个「用户回合」。`remind` 等到下一次 `turn.drain` 才进 history。已经 `running` 的那条 `cancel` 撤不掉。

## 两个 `on`

| 目的 | API |
|---|---|
| 已落盘事实、Feature `fire` | `session.on('message.appended' \| 'turn.ended' \| …)` |
| streaming / retry / 工具中间态 | `agent.on('llm.streaming.part' \| 'tool.update' \| …)` |

`agent.on('turn.done'|'turn.failed'|'turn.aborted')` 会等到这次 journal 写入链结束，但仍是机器载荷，和节点上的 `turn.ended` 不是同一条。事件总表见 [events](../reference/events.md)。

退出：`await app.disposeAsync()`。

## 相关文档

- 报文 → [HistoryMessage 与 Delta](../reference/history-message.md)
- 队列与状态机 → [agent-machine](../explanation/agent-machine.md)
- 下一篇：写 Todo Feature → [02](02-add-todo-feature.md)
