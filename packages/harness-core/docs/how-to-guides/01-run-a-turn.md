# Run a Turn

The smallest end-to-end path through the harness: assemble it, open a
session and an agent, give the agent a requester, run one turn, read the
result. Everything below is real API — the test suite drives exactly this
flow (`test/features/todo.test.ts`), and the product-shaped version of it is
`example/cli.ts`.

## 1. Create the App

```ts
import { createApp } from '@moonshot-ai/harness-core';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';

const app = createApp({ space: memorySessionSpace() });
```

`memorySessionSpace()` keeps everything in memory — right for tests and
one-shot runs. For a durable host use `nodeSessionSpace(dataRoot)` from
`@moonshot-ai/agent-core/session/backend/node` (see
[Persistence](../explanation/persistence.md)).

## 2. Add Features

```ts
import { todo, interaction } from '@moonshot-ai/harness-core';
import { harnessPreset } from '@moonshot-ai/harness-core/preset';

await app.features.add(todo);
await app.features.add(interaction);
// or the whole default bundle in one go:
for (const feature of harnessPreset) await app.features.add(feature);
```

`features.add(feature)` with no scope mounts the feature's app unit once and
its session/agent units in every session and agent — including ones created
later. See [Architecture](../explanation/architecture.md#registration-and-scope)
for scoped registration.

## 3. Open a Session and an Agent

```ts
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

const session = await app.open('s1');
const { agent } = await session.ensureAgent(MAIN_AGENT_ID, {
  systemPrompt: 'You are a helpful assistant.',
  maxSteps: 20,
});
```

`app.open` is startup/resume/fork in one call: an id that already exists
in the space resumes. `session.ensureAgent` opens the agent with a harness-managed
`AgentRuntime` (see [Agent Runtime](../explanation/agent-runtime.md)).

## 4. Attach a Requester

The agent needs an LLM requester in its runtime slot. The direct way — what
tests do — is to look the runtime up from the session and assign the slot:

```ts
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

const runtime = session.agentRuntime(MAIN_AGENT_ID);
if (runtime === undefined) throw new Error('no runtime');
runtime.requester = myRequester;
```

For a smoke test, `myRequester` can be a scripted fake (this is the exact
pattern the harness tests use):

```ts
import { createAssistantMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

const scripted: LoopLlmRequester = {
  with() { return this; },
  request: (part) => part as never,
  generate: async () => ({
    type: 'done',
    message: createAssistantMessage([{ type: 'text', text: 'hello from the model' }]),
  }),
};
runtime.requester = scripted;
```

In a product host you normally do nothing here: with the `provider-catalog`
feature mounted (it is in `harnessPreset`) and a default model configured,
the catalog binds a managed requester into the slot automatically — see
[Agent Runtime](../explanation/agent-runtime.md#managed-model-binding-provider-catalog).
For building a raw requester by hand, see agent-core's
`docs/en/how-to-guides/make-an-llm-request.md`.

## 5. Run the Turn

```ts
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { createUserMessage } from '@moonshot-ai/agent-core/llm/message';

const outcome = await agent.loop.runTurn(
  createUserEntry(createUserMessage('Say hi'), { source: 'input' }),
);
console.log(outcome.type); // 'done' | 'aborted' | 'failed' | 'blocked'
```

`runTurn(entry, { signal? })` is accepted only while the loop is idle and
resolves with the turn's `TurnOutcome`; aborting the optional signal aborts
the turn. The fire-and-forget alternative is the inbox:

```ts
agent.loop.submit(createUserEntry(createUserMessage('Say hi'), { source: 'input' }));
const ended = await agent.loop.wait('turn.ended');
```

While the turn runs, subscribe to `agent.loop` for loop-local events
(streaming deltas, tool progress) or use `app.on(...)` for the forwarded,
durable ones (`message.appended`, `turn.ended`, feature events) — see
[Events](../reference/events.md).

## 6. Read the State

```ts
await agent.flush(); // push the recorded events into the log
const { messages, turns } = agent.view.getState(); // folded from the log
```

- `agent.loop.state` is the live projection: `status`, `messages`, `inbox`,
  `profile`, current `turn`, `tools`.
- `agent.view.getState()` is the durable projection (`LoopRecordState`)
  folded from the log — messages, settled profile, turn positions with
  outcomes. Call `agent.flush()` first if you need the latest batch
  included.

Feature state lives behind facades; e.g. with `todo` mounted, a probe
feature can `useInject(TodoRef)` and read `face.items.value` (see
[Develop a Feature](02-develop-a-feature.md#testing) for the probe pattern),
and HTTP clients read it through `agentFacade` (see
[Serve HTTP](04-serve-http.md)).

## 7. Close

```ts
await app.close();
```

This closes every session, agent, and feature unit, and with them the
sessions' journals. Reopening the same `sessionId` later resumes from
the logs — messages, profile, feature stores, and any unfinished turn.

## Complete Script

```ts
import { createApp, todo } from '@moonshot-ai/harness-core';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, memorySessionSpace } from '@moonshot-ai/agent-core/session/index';

const app = createApp({ space: memorySessionSpace() });
await app.features.add(todo);
const session = await app.open('s1');
const { agent } = await session.ensureAgent(MAIN_AGENT_ID);

const scripted: LoopLlmRequester = {
  with() { return this; },
  request: (part) => part as never,
  generate: async () => ({
    type: 'done',
    message: createAssistantMessage([{ type: 'text', text: 'hi' }]),
  }),
};
session.agentRuntime(MAIN_AGENT_ID)!.requester = scripted;

const outcome = await agent.loop.runTurn(
  createUserEntry(createUserMessage('hello'), { source: 'input' }),
);
console.log(outcome.type); // 'done'
await app.close();
```
