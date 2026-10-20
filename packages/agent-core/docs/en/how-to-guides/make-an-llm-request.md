# Make an LLM request

This is a how-to guide: send messages to a model using only `src/llm/` — one shot, no loop, no session, no persistence. A runnable version of this flow lives in `example/generate.ts` (`pnpm example`).

## Steps

1. Pick a built-in provider requester from `#/llm/builtin/provider/index` (`openAIRequester`, `anthropicRequester`, `kimiRequester`, …) and attach an endpoint. On Node, `endpointFromEnv(PROVIDER_ENV.<provider>)` (`src/node/env.ts`) reads the provider's `<NAME>_API_KEY` / `<NAME>_BASE_URL` and builds the endpoint; on other platforms, pass `{ baseUrl, credentials }` yourself.
2. Build messages with the canonical contract in `#/llm/message` (`createUserMessage`, or plain message objects).
3. Call `requester.generate({ model: { spec }, content: { messages } }, { signal, onEvent })`. The `onEvent` callback receives `llm.started`, streaming parts, usage, finish, notices and retry events as they happen.
4. Read the returned `LlmOutcome`: `done` carries `message` + `usage` + `finish`; `failed` carries a structured `error` (`kind` plus the original `rawError`); `aborted` carries the salvaged partial message (or none) and the abort `reason`.
5. Add optional request dimensions as needed: `protocol` (e.g. `stream: false`), `policy` (`retry`, `resolvers`, `recoveries`), `capability` / `thinking` overrides. The full list is in the input contract reference.

```ts
import { kimiRequester } from '#/llm/builtin/provider/index';
import { createUserMessage, extractText, type Message } from '#/llm/message';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';

const requester = kimiRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) });
const messages: readonly Message[] = [createUserMessage('Introduce yourself in one sentence.')];

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

## Notes

- A requester is immutable: `.with(part)` returns a new requester layered on the previous values. Build the base once, then layer `model` / `profile` per use.
- `generate` never mutates `messages`; the returned assistant message is yours to append to a history.
- Which failures are classified where, and which are retried automatically, is covered by the errors reference.
