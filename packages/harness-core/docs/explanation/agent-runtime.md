# Agent Runtime

`app.open` gives every session a log, a roster, and live agents with a loop —
and nothing else. The product needs more per-agent state that is *not*
durable (which LLM to call, which tools exist this run, which policy entries
apply) and *not* part of the loop's own state. That record is the
`AgentRuntime` (`src/runtime/agents.ts`), and this document explains its
semantics.

## The Record

```ts
interface AgentRuntime {
  readonly agentId: string;
  requester: LoopLlmRequester | undefined;     // the requester slot
  readonly resolvers: MessageResolver[];       // live policy arrays
  readonly recoveries: LlmRecovery[];
  readonly retryables: LlmRetryable[];
  readonly executor: ToolExecutorHost;         // tool handlers
  readonly tools: Map<string, ToolDefinition>; // tool descriptions
  hostSystemPrompt: string | undefined;        // the reserved `host` prompt section
}
```

One `AgentRuntime` exists per (session, agentId) pair, created lazily by
`session.ensureAgent` and kept in the session handler itself (`AppSession`,
`src/app/session.ts`), so runtimes die with their session. Hosts look one up
with `session.agentRuntime(agentId)`; agent
feature units reach the current agent's record with `useAgentRuntime()`
(which throws if the agent was not opened through the session handler — e.g.
opened via a bare `session.open`).

## `session.ensureAgent`

```ts
const { agent, runtime } = await session.ensureAgent('main', {
  systemPrompt: 'You are Kimi.',
  maxSteps: 100,
  maxResultChars: 60_000,
  hooks: [/* extra HookRegistration[] */],
  init: { source: 'spawn:main:coder' },
});
```

- Returns the **live agent** if one is already open; otherwise creates the
  runtime (once — later calls with different options reuse the existing
  runtime) and opens the agent with `agentCaps(runtime, opts)`. The resolved
  value carries both the agent and its runtime.
- `OpenAgentOptions.systemPrompt` seeds the reserved `host` prompt
  section; `maxResultChars` becomes the executor's truncation policy;
  `maxSteps` installs agent-core's `createMaxStepsHook`; `hooks` are extra
  loop hook registrations; `init` is forwarded to `session.open` /
  `session.fork` (the agent's durable `source`).
- `session.forkAgent(sourceId, agentId, opts)` is the fork twin: same
  runtime handling over `session.fork`.
- The HTTP transport has its own entry point for cold sessions:
  `resumeSession(app, sessionId)` re-creates runtimes (default options) for
  every agent in the roster. Both paths converge on the same per-session
  registry, so a runtime made by either is visible to `useAgentRuntime()`.

## The Requester Slot and the Live Policy Arrays

`agentCaps` hands the loop a requester **getter**, read once per step by the
loop's request actor:

```ts
requester: () => {
  const base = runtime.requester;
  if (base === undefined) throw new Error(`agent '${agentId}' has no requester`);
  return base.with({
    policy: {
      resolvers: () => [...runtime.resolvers],
      recoveries: () => [...runtime.recoveries],
      retryables: () => [...runtime.retryables],
    },
  });
}
```

Two consequences:

1. **The slot is assignable at any time.** Setting `runtime.requester`
   changes what the *next* step calls — no re-registration, no loop restart.
   A turn already in flight picks it up at its next LLM request. An agent
   with no requester fails its turn with `agent '<id>' has no requester`.
2. **Policy arrays are read live.** `useMessageResolver`,
   `useLlmRecovery`, and `useLlmRetryable` push into these arrays and remove
   on scope dispose; every request re-reads them through the `.with()`
   layering, so feature mount/unmount changes apply to the very next
   request, mid-turn included.

## Tools: Registry plus Profile Sync

Tool contribution is two registrations in one hook
(`useAgentTools(...definitions)`):

- each `ToolDefinition` goes into `runtime.tools` (empty name and duplicates
  throw) and its handler into `runtime.executor` via agent-core's
  `useToolHandler`, and
- `syncAgentTools` pushes the full description set into the loop's profile
  with `loop.setTools`.

The loop settles profile changes only while **idle or at a step's ending**;
a mid-turn `setTools` is rejected with `tools.rejected`. `syncAgentTools`
absorbs that freeze: on rejection it waits for the next `step.ended` /
`turn.ended` and retries in a microtask, so tool changes are *eventually
consistent within the turn* and guaranteed visible from the next step. On
unit dispose the definitions are withdrawn and the profile re-synced.

(If you only need the executor half — a handler with no profile entry —
agent-core's `useToolHandler(definition)` / `useToolHandler(name, handler)`
does that alone.)

## System Prompt: Sections as a Contribution Point

The system prompt is assembled by the harness app layer: `src/app/system-prompt.ts`
owns a `SystemPromptSections` collection, and every agent unit assembles the
contributed sections into the loop's profile exactly once at agent create
(wired into `AgentUnit`).

`useSystemPrompt({ id, text, priority? })` (from
`#/app/index`) contributes a named section, withdrawn
automatically when the unit unmounts. The create-time assembly sorts by
`priority` (default 0, registration order breaks ties), drops blank texts,
lets a later registration replace an earlier one with the same id, joins
with `'\n\n'`, and lands as a single settle fired from a `useMounted` hook
registered after the feature mirror's — so by the time it runs, every
feature unit of the mount pass has already contributed, and the loop is
still guaranteed idle (the settle runs before `session.open` resolves,
hence before any turn can start). An agent whose replayed log already
carries a system prompt — resume or fork — never re-assembles: the prompt is
reduced from the durable record and later section changes are ignored.

The reserved `host` section (priority `-100`, so it stays first) is
contributed by an internal app feature from `runtime.hostSystemPrompt`,
seeded by `OpenAgentOptions.systemPrompt` (and by the pre-open helpers in
spawn and session-init). After the create-time settle the prompt is frozen
for the agent's lifetime.

## Managed Model Binding (provider-catalog)

Most hosts never touch `runtime.requester` directly: the `provider-catalog`
feature binds models to agents through a three-level pipeline, persisting
the choice as it goes.

**App level — the catalog.** The app unit runs agent-core's
`createProviderCatalog()` and projects three inputs into it:

- **config** — the `providers` / `models` / `modelCatalog` / `defaultModel` /
  `thinking` config sections (declared via `useConfigSection`, plus the Kimi
  env overlay). Models are restored even when they have no matching
  `providers` entry,
- **contributions** — `useProvider({ handle, info? })` entries from features
  such as `kimi` (which also contributes its protocol factory via
  `useProviderProtocol`), and
- **credentials** — `CredentialResolvers`, ending in a static env/apiKey
  resolver.

Provider contributions carry only the handle and optional init info; config
`models` is the only model list. Refresh contributions (`useProviderRefresh`)
return `config key → complete model record`. A successful refresh rebuilds
canonical aliases while preserving user aliases, extras, and overrides. A
successful empty result keeps the provider's previous models instead of
deleting them and rebuilds only canonical aliases. A failed refresh leaves both
the provider and its previous models unchanged and writes nothing back.

Every model with a live requester is published as a `CatalogModelBinding`
into the `CatalogModels` collection. The app unit exposes two facades:
`ProviderCatalogRef` (providers/models/requester, `addProvider`, `addModel`,
`refresh`, `ping`, `retiredModelReplacement`, `onChanged`, `onRefreshFailed`,
`onRetiredModel`) and `ModelDefaultsRef` (`setDefaultModel(alias)`,
`setDefaultThinking(effort)` — both persisted to config). `ping(providerId,
modelId)` returns a `Promise<ProviderCatalogPingResult>` containing `ok`,
`durationMs`, and outcome details; unknown models and a not-yet-ready catalog
reject the promise rather than producing a synthetic success.

**Session level — the default.** A session-scoped feature store holds the
session's default model/thinking (`session.model_defaults` events), exposed
as `SessionModelRef` (`setModel` / `setThinking`); writes are dual-written
into the main agent's own log so the main agent's undo stays aligned.

**Agent level — the binding.** Each agent keeps its own
`model.bound` feature store (`AgentModelRef.current` /
`setModel(alias)` / `setThinking(effort)`), persisted in the agent's log
alongside its loop records. A watch computes the effective
alias — agent store → session default → config `defaultModel` — resolves it
against `CatalogModels` (`matchCatalogBinding`), and assigns
`runtime.requester` to the binding's requester (layered with a thinking
effort when one is requested). Two safeguards:

- **Manual wins.** If something else assigned the slot (a host, a test), the
  watch stops itself and never re-applies.
- **Ownership on dispose.** Unmounting clears the slot only if the binding
  still owns it.

The agent unit also registers `credentialsRecovery` (re-prompt for
credentials on auth failure) via `useLlmRecovery`.

Because the binding lives in the main agent's own log, `session.undo`
rewinds model switches together with the conversation — the model that was
active at the cut turn becomes active again.

## Reading Order for the Runtime Path

1. `src/runtime/agents.ts` — the record, caps, tool sync.
2. `src/app/session.ts` — the session handler: the registry, `ensureAgent` / `forkAgent`.
3. `src/app/units.ts` — the internal `host` prompt section feature.
4. `src/runtime/hooks.ts` — the contribution hooks features call.
5. `src/features/provider-catalog/feature.ts` — managed binding, end to end.
