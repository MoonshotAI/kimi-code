# Agent Runtime

`app.open` gives every session a log, a roster, and live agents with a loop —
and nothing else. The product needs more per-agent state that is *not*
durable (which tools exist this run) and *not* part of
the loop's own state. That record is the
`AgentRuntime` (`src/runtime/agents.ts`), and this document explains its
semantics.

## The Record

```ts
interface AgentRuntime {
  readonly agentId: string;
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

## The Loop's Requester and the Loop Policy Registry

Which LLM an agent calls is *not* part of the runtime record: it is the
loop's own runtime state, held by agent-core's requester primitive. A bare
`session.open(agentId, caps)` may seed it as `caps.requester`, but far more
commonly it is set through the loop after open:

```ts
agent.loop.setRequester(requester);   // set, swap or clear (undefined)
agent.loop.baseRequester;             // read the current one back
```

Three consequences:

1. **The requester is swappable at any time.** The loop's request actor
   reads the current requester once per step, so `setRequester(next)`
   changes what the *next* step calls — no re-registration, no loop
   restart. A turn already in flight picks it up at its next LLM request.
   With none set, every step or `loop.requester` side request fails with
   `loop has no requester`.
2. **It dies with the loop instance.** After `session.closeAgent` the next
   `session.ensureAgent` opens a fresh loop with no requester; whoever
   owns the binding re-applies it (provider-catalog does so from its
   agent-tier watch on every mount; manual hosts call `setRequester`
   again).
3. **Policy lives in the loop's native registry.** `useMessageResolver`,
   `useLlmRecovery`, and `useLlmRetryable` register into agent-core's
   `loop.policy` and remove on scope dispose; the registry is layered onto
   every request the loop runs and re-read on every attempt, so feature
   mount/unmount changes apply to the very next request, mid-turn included,
   and survive a requester swap.

## Tools: Registry plus Profile Sync

Tool contribution is two registrations in one hook
(`useAgentTools(...definitions)`):

- each `ToolDefinition` goes into `runtime.tools` (empty name and duplicates
  throw) and its handler into `runtime.executor` via agent-core's
  `useToolHandler`, and
- the agent's tools profile sync (`runtime.profileSync.tools`, built on the
  harness `createToolsSync` in `#/runtime/profile-sync`) is refreshed.

`loop.setTools` is accepted at any time and never rejected: until the first
request has used the current value (`step.started`), `refresh()` overwrites
the loop's tool list with the registered set; afterwards the value stays
byte-stable and a change produces one keyed system notice instead — removed
tools are announced (`tools-change`), while added or changed tools wait for a
`reload()` and are only reported to the host through the `tools.pending`
unit event. Refreshes are coalesced into a microtask, so a batch of
registrations or a feature remount settles once with the final consistent
set. On unit dispose the definitions are withdrawn and the sync re-run.

(If you only need the executor half — a handler with no profile entry —
agent-core's `useToolHandler(definition)` / `useToolHandler(name, handler)`
does that alone.)

## System Prompt: Sections as a Contribution Point

The system prompt is assembled by the harness app layer: `src/app/system-prompt.ts`
owns a `SystemPromptSections` collection, and every agent unit keeps the
contributed sections synced into the loop's profile through a prompt profile
sync (`runtime.profileSync.prompt`, built on the harness
`createSystemPromptSync` in `#/runtime/profile-sync`, wired into `AgentUnit`).
The loop itself only ever stores the joined string — sections are a
harness-side concept.

`useSystemPrompt({ id, text, priority? })` (from
`#/app/index`) contributes a named section, withdrawn
automatically when the unit unmounts. The sync sorts by
`priority` (default 0, registration order breaks ties), drops blank texts,
lets a later registration replace an earlier one with the same id, and joins
with `'\n\n'`. Until the first request has used the prompt
(`step.started`), `refresh()` overwrites it with the current sections;
afterwards the settled bytes stay frozen for prefix-cache stability and a
section change is announced as a keyed system notice (`system-prompt-change`)
naming the updated and removed sections. An agent whose replayed log already
carries a prompt — resume or fork — keeps the replayed value from the start
and only notices the diff against the current sections.

The reserved `host` section (priority `-100`, so it stays first) is
contributed by an internal app feature from `runtime.hostSystemPrompt`,
seeded by `OpenAgentOptions.systemPrompt` (and by the pre-open helpers in
spawn and session-init).

## Managed Model Binding (provider-catalog)

Most hosts never touch the loop's requester directly: the `provider-catalog`
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
against `CatalogModels` (`matchCatalogBinding`), and calls
`agent.loop.setRequester(...)` with the binding's requester (layered with a
thinking effort when one is requested). Two safeguards:

- **Manual wins.** If something else set the loop's requester (a host, a
  test), the watch stops itself and never re-applies.
- **Ownership on dispose.** Unmounting clears the requester only if the
  binding still owns it.

The agent unit also registers `credentialsRecovery` (re-prompt for
credentials on auth failure) via `useLlmRecovery`.

Because the binding lives in the main agent's own log, `session.undo`
rewinds model switches together with the conversation — the model that was
active at the cut turn becomes active again.

## Reading Order for the Runtime Path

1. `src/runtime/agents.ts` — the record, caps, tool sync.
2. `src/app/session.ts` — the session handler: the registry, `ensureAgent` / `forkAgent`.
3. `src/app/units.ts` — the internal `host` prompt section feature.
4. `src/app/hooks.ts` — the contribution hooks features call.
5. `src/features/provider-catalog/feature.ts` — managed binding, end to end.
