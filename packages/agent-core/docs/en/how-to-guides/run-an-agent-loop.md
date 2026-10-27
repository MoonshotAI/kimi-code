# Run an agent loop

This is a how-to guide: drive one tool-using agent with `src/loop/` + `src/llm/` — a turn/step state machine with hooks, but no session and no persistence. `example/loop.ts` is a runnable offline version with a fake requester (`pnpm example:loop`).

## Steps

1. Build a requester and layer the agent's profile on it: `profile.systemPrompt` and `profile.tools` (tool descriptions). A profile layered here acts as defaults — values set on the loop itself (see below) override it. Hand it to `createLoop({ requester })`, and swap it later at any time with `loop.setRequester(next)`; the loop reads the current requester once per step, so a swap takes effect from the next step. `loop.baseRequester` reads the current one back, and with none set every step or side request fails with `loop has no requester`.
2. Define a tool with `defineTool` (`src/tool/define.ts`). The schema produces both the `parameters` the model sees and the `args` type inside `execute`. `onUpdate` streams progress (surfaced as `tool.delta`); calling `detach(text)` moves the tool to the background and ends its entry immediately with `text` as the ack.
3. `createToolExecutor()` dispatches on the tool name. Pass it as `executor` to `createLoop({ requester, executor, hooks })`. `register` installs an implementation; `setTools` or the requester's `profile.tools` installs the description — neither is derived from the other. `invalidate(name, reason)` makes later calls return an in-band error without entering the handler, and `restore(name)` uses the same handler again. `createToolExecutor({ policy: { maxResultChars } })` truncates the final text result. `loop.executor` is the object that was passed in. An object with only `execute` is still a valid executor when there is nothing to dispatch.
4. The loop starts held. `loop.runTurn(entry)` runs one turn and resolves with its `TurnOutcome`; alternatively `submit` / `notify` queue prompts and `continue()` releases the hold. An aborted turn returns its prompt to the inbox and holds. `loop.close()` aborts a running turn without grace, so unfinished tool calls still get an aborted result before `turn.ended`.
5. `loop.subscribe(listener)` receives every `LoopEmitted` event: turn/step boundaries, `llm.streaming.*`, `tool.*`, hook lifecycle and hook failures. `loop.wait(type, { match, timeoutMs, signal })` awaits a single matching event as a promise.
6. Register guardrails as hooks — e.g. `createMaxStepsHook(() => 8)` ends the turn as `blocked` after 8 steps. `loop.hooks` supports pause/resume/remove and per-hook `onFailure` policies. The hook points in lifecycle order: `turn.starting` (once per turn, may block the turn); `message.appending` (per queued item, may rewrite the entry or block it); `step.starting` (once per step before the LLM request — not per retry, and a resumed turn's next step passes through it — with the current messages and profile; may rewrite the history, chained through the hooks and settled as a durable `context.settled`, or block the step); `tool.batch-starting` (once per tool batch before execution; a block applies to every call — each gets started/ended events with the blocked outcome sharing one optional result, and no per-call hooks or executors run); `tool.starting` (per call, may rewrite the call, block it with an optional result, or return `skipPermitting` to bypass the `tool.permitting` phase — the rest of the `tool.starting` chain still runs and a later block still settles the call) and then `tool.permitting` (per call, may rewrite the call or block it with an optional result) — every `tool.starting` hook runs before any `tool.permitting` hook regardless of registration order, rewrites chain through both phases, so safety and permission hooks always adjudicate the final rewritten call; `tool.ending` (per call after execution, may rewrite the result or stop the turn); `step.stopping` / `step.continuing` (at a step's ending, may continue a finished step or finish/block a continuing one).
7. Register LLM policy into the loop's native registry: `loop.policy.addResolver(resolver)` / `addRecovery(recovery)` / `addRetryable(retryable)` each return an unregister function, and every request the loop runs — step requests and `loop.requester` side requests alike — re-reads the lists on every attempt, so registering or unregistering applies mid-turn. Retryable extras are additive on top of the default table; `syntax` and `abort` stay sealed non-retryable. See LLM errors, retries and recoveries.

```ts
import { createUserEntry } from '#/history/message';
import { kimiRequester } from '#/llm/builtin/provider/index';
import { createUserMessage } from '#/llm/message';
import { createLoop, createMaxStepsHook } from '#/loop/index';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';
import { createToolExecutor, defineTool, zodSchema } from '#/tool/index';
import { z } from 'zod';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  schema: zodSchema(z.object({ city: z.string().describe('City name') })),
  async execute({ args, onUpdate }) {
    onUpdate?.({ key: 'query', text: `querying ${args.city}`, percent: 40 });
    const weather = await queryWeather(args.city);
    return { content: [{ type: 'text', text: weather }] };
  },
});

const tools = createToolExecutor();
tools.register(weatherTool);

const requester = kimiRequester
  .with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) })
  .with({ model: { spec: { provider: 'kimi', name: 'kimi-k2' } } });

const loop = createLoop({
  requester: requester.with({ profile: { systemPrompt: 'You are a helpful assistant.', tools: [weatherTool] } }),
  executor: tools,
  hooks: [createMaxStepsHook(() => 8)],
});

loop.subscribe((event) => {
  if (event.type === 'llm.streaming.part' && event.part.type === 'text') process.stdout.write(event.part.text);
});

const outcome = await loop.runTurn(
  createUserEntry(createUserMessage('What is the weather in Beijing?'), {
    promptId: 'demo-1',
    origin: { kind: 'user' },
  }),
);
console.log(outcome.type);
await loop.close();
```

## Provide the system prompt and tools

`loop.setSystemPrompt(text)` sets the system prompt as a plain string and `loop.setTools(descriptions)` sets the tool descriptions. Both are accepted at any time, including mid-turn, and take effect from the next request; read them back from `loop.state.profile.systemPrompt` and `loop.state.profile.tools`.

```ts
loop.setSystemPrompt('You are a helpful assistant.');
loop.setTools([weatherTool]);
```

The loop has no notion of prompt sections or contribution points — when the prompt and tools come from contributions that change at any time, the host keeps its own sync policy above these primitives (harness-core ships one that joins contributed sections into the prompt string, keeps the value byte-stable once a request has used it, and reminds later changes as keyed system notices).

`system_prompt.settled` / `tools.settled` are durable records (`src/loop/record.ts`), so a restored loop keeps its profile. And because a request merges dimensions requester-first, the loop's profile overrides any `profile` layered on the requester — the persisted value always wins after a reopen.

## Where to go next

- `loop.state` is a plain projection (status, held, inbox, the profile, messages, the running turn, and `calls` — the running tool calls including detached ones); `loop.requester` is a requester facade for side requests — it re-reads the loop's current base requester and fills in the current history as `content` on every `request`/`generate`, so `.with()` overrides always land on the latest configuration and context; `loop.waitForTasks` waits on background tools, `loop.waitForIdle()` settles the loop.
- Input commands (`submit`/`notify`/`remind`/`steer`/`cancel`/`setContext`/`setSystemPrompt`/`setTools`) are synchronous everywhere, including inside a `subscribe` listener or a hook: they return their ack and `loop.state` already reflects them. Events reach listeners in one global order, after the state change that produced them.
- The loop holds no persistence. `src/loop/record.ts` defines its durable contract (`LoopRecord` / `toLoopRecord` / `loopProjection`); for persistence that is already wired, use `src/session/` — see Run a session with subagents.
- To restore after a crash, fold the records with `loopProjection` and pass `{ profile, messages, nextTurnId, unfinished, inbox: { notify } }` as `input`. With an `unfinished` turn the loop starts with status `interrupted`: `continue()` resumes that turn when its history allows it (`turn.resumed`, same turn id, next step), and every other trigger — `abort`, `runTurn`, `submit`, `notify`, `steer` — first ends it as `aborted` with reason `CRASHED`, filling in aborted results for unanswered tool calls.
