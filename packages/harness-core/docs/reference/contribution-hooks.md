# Contribution Hooks Reference

Every hook a feature unit can call, grouped by the module that exports it.
"Agent level" / "session level" marks the unit levels the hook is meaningful
in; hooks that need `useAgent()` throw below the wrong level.

## Harness Runtime Hooks

Module: `@moonshot-ai/harness-core` (root) — source `src/runtime/`.

| Hook | Semantics |
|---|---|
| `useAgentRuntime()` | Returns the current agent's `AgentRuntime` (requester slot, policy arrays, tool registry, prompt sections); throws if the agent was not opened via `ensureAgent`. Agent level. |
| `useAgentTools(...definitions)` | Registers tool definitions into the runtime registry **and** the loop executor, then syncs the loop's tool profile (retrying after `step.ended`/`turn.ended` when the profile is frozen mid-turn); withdraws and re-syncs on dispose. Empty name / duplicate name throws. Agent level. |
| `useSystemPrompt(...sections)` | Contributes named `{ id, text, priority? }` system prompt sections; the assembled prompt is settled once (see [Agent Runtime](../explanation/agent-runtime.md#system-prompt-sections-one-settle-frozen)). Empty id, the reserved `host` id, or duplicates throw. Agent level. |
| `useMessageResolver(resolver)` | Appends a `MessageResolver` to the live policy array read by every LLM request; removed on dispose. Agent level. |
| `useLlmRecovery(recovery)` | Appends an `LlmRecovery` to the live policy array; removed on dispose. Agent level. |
| `useLlmRetryable(retryable)` | Appends an `LlmRetryable` to the live policy array; removed on dispose. Agent level. |
| `useLoopEvent(type, handler)` | Subscribes to one `LoopEmitted` type on the agent's loop (e.g. `'turn.started'`, `'llm.ended'`); unsubscribed on cleanup. Agent level. |
| `useBlobs()` | Returns the session's `BlobStore`. Agent or session level. |
| `useWaitForTasks()` | Returns the loop's `WaitForTasks` handle (await detached/background tool tasks). Agent level. |
| `useFeatureStore(scope, name, projection)` | Opens a durable event-sourced feature store (`'agent'` → log `agents/<agentId>/<name>`, `'session'` → log `<name>`) with `{ state, ready, dispatch, onCommit }`. See [Persist Feature State](../how-to-guides/03-persist-feature-state.md). Agent or session level. |
| `undoAgentTurns(app, session, agentId, turns)` | Plain async function (not a hook): rewinds the agent loop log and every `agents/<agentId>/` feature log to a turn boundary. |

## App / Agent / Loop Hooks (agent-core)

Module: `@moonshot-ai/agent-core/app/index`.

| Hook | Semantics |
|---|---|
| `useApp()` / `useSession()` / `useAgent()` | Returns the domain object of the current level (an agent unit sees all three; a session unit sees session + app). |
| `useRequester()` | Sugar for `useAgent().loop.requester` — the `LoopLlmRequester` for side requests (summaries, titles) filled with the live history. Agent level. |
| `useToolHandler(definition)` / `useToolHandler(name, handler)` | Registers on the loop's executor registry only (no tool-profile sync — prefer `useAgentTools` for model-visible tools); removed on scope dispose. Agent level. |

### Loop Hook Helpers

Each registers a hook at one loop hook point as
`(hook, { id?, onFailure? })` and removes it synchronously in
`onScopeDispose`, so a remounted feature reusing the same `id` never
collides with its outgoing instance. All are agent level. Signatures and
decision shapes: `@moonshot-ai/agent-core/loop/index` (`LoopHooks`).

| Helper | Hook point semantics |
|---|---|
| `useTurnStarting(hook, opts?)` | Once per turn before it starts, with the pending inbox; may block the turn (`{ type: 'blocked', cause }`). Skipped when a resumed turn continues. |
| `useMessageAppending(hook, opts?)` | Before a queued inbox item is appended to the history; may rewrite the entry or block it. |
| `useStepStarting(hook, opts?)` | Once per LLM request (not per retry) with the current messages and profile; may rewrite the history (returned `messages` are settled as `context.settled`) or block the step (`blocked at step.starting`). Compaction and date-change hook in here. |
| `useToolBatchStarting(hook, opts?)` | Once after a done reply that carries tool calls, before any tool actor spawns; a block applies to every call in the batch (each recorded with the blocked outcome, no per-call hooks or executors run). |
| `useToolStarting(hook, opts?)` | Per tool call, first phase; may rewrite the call or block it. Rewrites chain through to `tool.permitting`. |
| `useToolPermitting(hook, opts?)` | Per tool call, second phase — always adjudicates the final rewritten call; the permission feature's allow/deny lives here. The first block settles the call with the blocked outcome, skipping later hooks and the executor. |
| `useToolEnding(hook, opts?)` | After a tool call produced a result; may replace the result and/or stop the turn (`stopTurn: true`). |
| `useStepStopping(hook, opts?)` | When a step is about to stop with a `done`/`failed` draft outcome; may force the turn to continue (`{ type: 'continue', cause }`). Compaction's post-step check hooks in here. |
| `useStepContinuing(hook, opts?)` | When a step is about to continue to the next one; may end the turn instead (`{ type: 'done' \| 'blocked', cause }`). |

## Kernel Hooks (agent-core)

Module: `@moonshot-ai/agent-core/kernel/index`.

| Hook | Semantics |
|---|---|
| `provide(token, value)` | Registers a certain-token value visible to the unit's subtree (throws for consumers when missing). |
| `useExpose(token, value)` | Exposes a facade (`createFacadeToken`) on the parent node once the unit finishes mounting; withdrawn when the unit starts unmounting. |
| `useInject(token)` | Certain token → the value (throws when absent); facade token → `Readonly<ShallowRef<T \| undefined>>` tracking the nearest exposure. |
| `useContribute(collection, value, priority?)` | Adds a value to a collection token (`createCollection`), folded root-to-node by ascending priority; withdrawn on cleanup. |
| `useCollection(collection)` | `ComputedRef` of the folded collection visible from this unit. |
| `useFire()` | Returns the function that fires an event from this unit (bubbles up, enriched with `EventContext`). |
| `useOn(type, handler, { once? }?)` | Listens for an event type (or `'*'`) on this unit's host node; removed on cleanup. |
| `useWait(type, opts?)` | Awaits one matching (enriched) event on this unit; rejects on timeout, external abort, or unit unmount. |
| `useReady(promise)` | Tracks async startup so `ready()` (and thus `app.create` / `session.open`) awaits it; a rejection fails the unit. |
| `useMounted(callback)` | Runs the callback after the unit becomes active. |
| `useCleanup(fn)` | Registers teardown run (in LIFO order) when the unit unmounts. |
| `useChildren(source)` | Mirrors a reactive list of child unit entries (`{ key, recipe, props? }`), mounting/updating/disposing as it changes. |

Also exported from the kernel: `createUnit`, `mountRoot`, `EventContext`
(the enrichment collection), token factories `createToken` /
`createFacadeToken` / `createCollection`, and the `@vue/reactivity`
primitives (`ref`, `reactive`, `computed`, `watch`, `watchEffect`,
`effectScope`, `shallowRef`, …) — feature units should import reactivity
from here rather than from Vue directly.

## Feature-Local Contribution Points

Several features define their own collections for other features to
contribute to; these are documented with their feature and listed in
[Facades](facades.md#collection-tokens) (`Providers`, `CatalogModels`,
`ProviderProtocols`, `CredentialResolvers`, `ConfigSections`,
`ConfigOverlays`, `TelemetryEvents`, `SkillSources`, `McpServerSources`,
`PtcToolGuards`, `HookSources`, `ProfileFinders`, `SessionActionContributions`,
`HttpRoutes`).
