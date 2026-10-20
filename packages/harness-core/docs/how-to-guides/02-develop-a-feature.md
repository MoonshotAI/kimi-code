# Develop a Feature

A feature is the unit of all product behavior in harness-core. This guide
builds one from scratch: units, facade, events, a tool, durable state, and
tests. The running example is a minimal "counter" feature that gives the
agent an `IncrementCounter` tool and remembers the count across restarts.

## Scaffold

```ts
// src/features/counter/feature.ts
import { createFeature } from '@moonshot-ai/agent-core/app/index';

export const counter = createFeature('counter', {
  agent() {
    // runs once per agent, synchronously, before session.open resolves
  },
});
```

- `createFeature(name, { app?, session?, agent? })` — one optional unit
  setup per level; at least one is required. The units are named
  `<name>:<level>`, which shows up in `unit.error` events and logs.
- Setups run synchronously at mount and must return nothing. Async startup
  goes through `useReady(promise)` so `app.create` / `session.open` await
  it.
- Inside a setup, `useApp()` / `useSession()` / `useAgent()` (from
  `@moonshot-ai/agent-core/app/index`) give the domain objects of your
  level, and every kernel hook is available
  ([Contribution Hooks](../reference/contribution-hooks.md)).

Features with options are factories that close over their props and return
`Feature<void>` — the house style:

```ts
export function createCounter(props: { readonly startAt?: number } = {}): Feature<void, CounterEvent> {
  return createFeature<CounterEvent>('counter', {
    agent() { /* props.startAt is in scope */ },
  });
}
```

(Typed props exist too — `createFeature<E, P>` plus
`features.add(feature, { props })` — but the built-in features prefer
factories; follow that.)

## Declare Events

Pass the event union as the first type parameter and fire with `useFire()`:

```ts
import { useFire } from '@moonshot-ai/agent-core/kernel/index';
import { type FeatureEvent } from '@moonshot-ai/harness-core';

export interface CounterIncrementedEvent extends FeatureEvent {
  readonly type: 'counter.incremented';
  readonly by: number;
}
export type CounterEvent = CounterIncrementedEvent;

// inside the unit:
const fire = useFire();
fire({ type: 'counter.incremented', by: 2 });
```

(`FeatureEvent` is a `RuntimeEvent` with an optional `turnId` — the stamp
`useFeatureStore` adds at dispatch time. Plain transient events can extend
`RuntimeEvent` instead.)

Events bubble to the app root enriched with `sessionId` / `agentId`, so
hosts subscribe with the typed form `app.on(counter, 'counter.incremented',
handler)` — the handler is narrowed to your union. Name every event type
`<feature>.<thing>` so the `'*'` prefix form `app.on(counter, '*', h)` works.

Two ways to emit, both reaching `app.on` the same way:

- **`useFire()` directly** — for transient signals (task started, a file
  changed) that are not persisted;
- **`store.dispatch(...)`** — durable events are re-fired as unit events
  after the commit lands (see below), so one write gives you persistence
  *and* notification. The counter uses this path; the declared union above
  is exactly the store's event type.

## Expose a Facade

```ts
import { computed, createFacadeToken, useExpose, useInject, type ComputedRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

export interface CounterFace {
  readonly count: ComputedRef<number>;
  increment(): Promise<void>;
}
export const CounterRef = createFacadeToken<CounterFace>('counter');

// inside the agent unit:
useExpose(CounterRef, { count: computed(() => store.state.value.count), increment });

// a sibling feature consumes it (agent level or below):
const counter: Readonly<ShallowRef<CounterFace | undefined>> = useInject(CounterRef);
```

Facades are visible after your unit finishes mounting and vanish when it
starts unmounting; consumers must handle `undefined`. Keep the face small —
refs and methods, no internal handles.

## Register Tools

Use `useAgentTools` (from `@moonshot-ai/harness-core`), never the raw loop,
so the definition lands in the runtime registry *and* the loop's tool
profile with freeze-aware re-sync:

```ts
import { useAgentTools, useFeatureStore } from '@moonshot-ai/harness-core';
import { defineTool, zodSchema } from '@moonshot-ai/agent-core/tool/index';
import { z } from 'zod';

useAgentTools(
  defineTool({
    name: 'IncrementCounter',
    description: 'Increment the session counter.',
    schema: zodSchema(z.object({ by: z.number().int().positive().default(1) })),
    execute: async ({ args }) => {
      await store.dispatch([{ type: COUNTER_INCREMENTED, by: args.by }]);
      return { content: [{ type: 'text', text: `count is now ${store.state.value.count}` }] };
    },
  }),
);
```

`defineTool` parses the JSON arguments with your schema before the typed
`execute`; `zodSchema` adapts a zod schema (`parameters` may also be a plain
JSON-schema object, as the todo feature's hand-written tool shows). Tool
results are truncated to the executor's `maxResultChars`. Duplicate tool
names across features throw at mount.

Other contributions you will reach for, all agent level
([full table](../reference/contribution-hooks.md)):

- `useSystemPrompt({ id, text, priority? })` — a prompt section (settled
  once per agent),
- `useStepStarting` / `useToolPermitting` / … — loop hook helpers for
  turn-cycle intervention,
- `useMessageResolver` / `useLlmRecovery` / `useLlmRetryable` — LLM policy
  entries,
- `useLoopEvent(type, handler)` — react to loop emissions.

## Keep Durable State

```ts
const COUNTER_INCREMENTED = 'counter.incremented' as const;

const store = useFeatureStore('agent', 'counter', {
  initial: () => ({ count: 0 }),
  reduce: (state, { event }) =>
    event.type === COUNTER_INCREMENTED ? { count: state.count + event.by } : state,
});
```

The projection type is `Projection<S, E>` from
`@moonshot-ai/agent-core/store/index` — `{ initial, reduce }` over journal
entries (`{ seq, time, event }`).

The store survives restarts, stamps every dispatched event with the current
`turnId`, and rewinds in sync with `undoAgentTurns`. The full semantics are
in [Persist Feature State](03-persist-feature-state.md); the persistence
model in [Persistence](../explanation/persistence.md).

## The Re-entrancy Discipline

Your setup will run again — on agent reopen, on re-registration with a
different feature object, on remove-then-add. Write it to be re-runnable:

- **Pair every registration with cleanup.** The harness and agent-core
  hooks (`useAgentTools`, the loop hook helpers, `useToolHandler`,
  `useFeatureStore`, `useOn`) already do; anything you register manually
  (subscriptions, timers, external handles) goes into `useCleanup`.
- **No unkeyed module-level state.** Share across instances with
  `WeakMap<Agent, …>` / `WeakMap<Session, …>` (see `spawn`, `tool-select`).
- **No duplicate-prone globals.** Throwing in a setup fails the unit, which
  reports `unit.error` up the tree and unmounts it.

## Testing

The canonical harness test pattern — memory space, a scripted requester, a
probe feature to capture facades (abridged from
`test/features/todo.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  undoAgentTurns,
} from '@moonshot-ai/harness-core';

function scriptedRequester(next: (rest: any) => any): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as never,
    generate: async (rest) => next(rest),
  };
  return self;
}

function captureFacade(): { feature: Feature<void>; face: () => CounterFace | undefined } {
  let exposed: Readonly<ShallowRef<CounterFace | undefined>> | undefined;
  const feature = createFeature('counter-probe', {
    agent: () => {
      exposed = useInject(CounterRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

it('counts across turns and rewinds with undo', async () => {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const probe = captureFacade();
  await harness.app.features.add(counter);
  await harness.app.features.add(probe.feature);
  const session = await harness.app.create({ sessionId: 's1' });
  const agent = await harness.ensureAgent(session, 'main');
  harnessInternals(harness.app).agents.get(session)!.get('main')!.requester =
    scriptedRequester(() => ({
      type: 'done',
      message: createAssistantMessage([{ type: 'text', text: 'ok' }], [
        { type: 'function', id: 'c1', name: 'IncrementCounter', arguments: '{"by":2}' } satisfies ToolCall,
      ]),
    }));

  const seen: number[] = [];
  harness.app.on(counter, 'counter.incremented', (event) => seen.push(event.by));

  const outcome = await agent.loop.runTurn(
    createUserEntry(createUserMessage('bump'), { source: 'input' }),
  );
  expect(outcome.type).toBe('done');
  await agent.flush();
  expect(seen).toEqual([2]);
  expect(probe.face()?.count.value).toBe(2);

  await undoAgentTurns(harness.app, session, 'main', 1);
  expect(probe.face()?.count.value).toBe(0);
  await harness.close();
});
```

Notes on the moving parts:

- **`memoryHarnessSpace()`** makes reopen/undo paths testable — close the
  session with `harness.app.close('s1')` and re-`app.create` to prove your
  store rehydrates.
- **The scripted requester** answers per `generate` call; the real tests
  inspect `rest.content.messages` to script multi-turn sequences (tool call
  on the first user message, `done` after the tool result).
- **The probe feature** is how tests (and the example app's `ExampleProbe`)
  read facades without a transport.
- `app.on(counter, 'counter.incremented', ...)` verifies your declared
  events end-to-end.

## Checklist Before You Commit

- [ ] Event types are `<feature>.<thing>` and declared via `createFeature<E>`.
- [ ] Facade exposed with `useExpose`, token created with `createFacadeToken`.
- [ ] Tools via `useAgentTools`; names unique across the preset.
- [ ] Durable state in `useFeatureStore`, never in module state.
- [ ] Every manual registration has a `useCleanup`.
- [ ] A test in `test/features/<name>.test.ts` drives a real turn with the
      scripted requester (follow the nearest existing feature test).
- [ ] Export the feature from `src/features/<name>/index.ts` and the package
      `src/index.ts`; if it belongs in the default bundle, add it to
      `src/preset.ts`.
