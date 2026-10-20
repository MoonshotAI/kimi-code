# 发起一次 LLM 请求

这是一篇 how-to 文档：只使用 `src/llm/` 向模型发送消息——单次请求，没有 loop、没有 session、没有持久化。可运行的完整版本在 `example/generate.ts`（`pnpm example`）。

## 步骤

1. 从 `#/llm/builtin/provider/index` 选一个内建 provider requester（`openAIRequester`、`anthropicRequester`、`kimiRequester`……），并附上 endpoint。在 Node 上，`endpointFromEnv(PROVIDER_ENV.<provider>)`（`src/node/env.ts`）会读取该 provider 的 `<NAME>_API_KEY` / `<NAME>_BASE_URL` 并组装 endpoint；其他平台自行传入 `{ baseUrl, credentials }`。
2. 用 `#/llm/message` 的规范契约构造消息（`createUserMessage`，或直接写字面量消息对象）。
3. 调用 `requester.generate({ model: { spec }, content: { messages } }, { signal, onEvent })`。`onEvent` 回调会陆续收到 `llm.started`、流式 part、usage、finish、notice 和重试事件。
4. 读取返回的 `LlmOutcome`：`done` 携带 `message` + `usage` + `finish`；`failed` 携带结构化的 `error`（`kind` 加上原始 `rawError`）；`aborted` 携带打捞出的部分消息（可能没有）和 abort 的 `reason`。
5. 按需添加可选的请求维度：`protocol`（如 `stream: false`）、`policy`（`retry`、`resolvers`、`recoveries`）、`capability` / `thinking` 覆盖。完整清单见输入契约参考文档。

```ts
import { kimiRequester } from '#/llm/builtin/provider/index';
import { createUserMessage, extractText, type Message } from '#/llm/message';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';

const requester = kimiRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) });
const messages: readonly Message[] = [createUserMessage('用一句话介绍你自己。')];

const result = await requester.generate(
  {
    model: { spec: { provider: 'kimi', name: 'kimi-k2' } },
    content: { messages },
    policy: { retry: { maxAttemptsPerStep: 2 } },
  },
  {
    signal: AbortSignal.timeout(60_000),
    onEvent: (event) => {
      if (event.type === 'llm.streaming.part' && event.part.type === 'text') {
        process.stdout.write(event.part.text);
      }
    },
  },
);

switch (result.type) {
  case 'done':
    console.log(extractText(result.message), result.usage);
    break;
  case 'failed':
    console.error(`${result.error.kind}: ${result.error.message}`);
    break;
  case 'aborted':
    console.error('aborted', result.reason);
    break;
}
```

## 说明

- requester 是不可变的：`.with(part)` 返回一个叠加了前值的新 requester。基础 requester 建一次，之后按用途叠加 `model` / `profile`。
- `generate` 不会改动 `messages`；返回的 assistant 消息由你自己决定是否追加进历史。
- 失败如何分类、哪些失败会被自动重试，见错误参考文档。
