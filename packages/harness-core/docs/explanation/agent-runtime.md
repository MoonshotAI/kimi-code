# Agent Runtime

`createApp` gives every agent a loop, a log, and a view — and nothing else.
The product needs more per-agent state that is *not* durable (which LLM to
call, which tools exist this run, which policy entries apply) and *not* part
of the loop's own state. That record is the `AgentRuntime`
(`src/runtime/agents.ts`), and this document explains its semantics.

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
  readonly sections: Map<string, SystemPromptSection>;
  systemPromptSettled: boolean;
}
```

One `AgentRuntime` exists per (session, agentId) pair, created lazily by
`ensureAgent` and kept in `harnessInternals(app).agents` — a
`WeakMap<Session, Map<string, AgentRuntime>>`, so runtimes die with their
session. Agent feature units reach it with `useAgentRuntime()` (which throws
if the agent was not opened through the harness — e.g. opened via a bare
`session.open`).

## `ensureAgent`

```ts
const agent = await harness.ensureAgent(session, 'main', {
  systemPrompt: 'You are Kimi.',
  maxSteps: 100,
  maxResultChars: 60_000,
  hooks: [/* extra HookRegistration[] */],
});
```

- Returns the **live agent** if one is already open; otherwise creates the
  runtime (once — later calls with different options reuse the existing
  runtime) and opens the agent with `agentCaps(runtime, opts)`.
- `EnsureAgentOptions.systemPrompt` seeds the reserved `host` prompt
  section; `maxResultChars` becomes the executor's truncation policy;
  `maxSteps` installs agent-core's `createMaxStepsHook`; `hooks` are extra
  loop hook registrations.
- The HTTP transport has its own entry point for cold sessions:
  `resumeSession(app, sessionId)` re-creates runtimes (default options) for
  every agent in the roster. Both paths converge on the same registry, so a
  runtime made by either is visible to `useAgentRuntime()`.

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

## System Prompt: Sections, One Settle, Frozen

`useSystemPrompt({ id, text, priority? })` contributes a named section.
Validation rejects the empty id and the reserved `host` id (used by
`EnsureAgentOptions.systemPrompt`), and duplicate ids throw.

Settling is deliberately **once per agent**: the first contribution flips
`systemPromptSettled` and schedules a microtask that assembles the sections
registered so far — non-empty texts sorted by `priority` (default 0), joined
with `'\n\n'`, empty result meaning `undefined` — and calls
`loop.setSystemPrompt`. Because all agent feature units mount synchronously
in the same pass, every section contributed at mount time lands in that one
settle. After it:

- later section additions or removals update the map but **never
  re-settle** — the prompt is frozen,
- if the loop's profile already carries a system prompt (restored from the
  loop log on reopen), the settle is skipped entirely.

Hosts that need a different prompt per agent should pass
`EnsureAgentOptions.systemPrompt` or layer it on the requester's `profile`;
features should treat sections as mount-time declarations.

## Managed Model Binding (provider-catalog)

Most hosts never touch `runtime.requester` directly: the `provider-catalog`
feature binds models to agents through a three-level pipeline, persisting
the choice as it goes.

**App level — the catalog.** The app unit runs agent-core's
`createProviderCatalog()` and reconciles three inputs into it:

- **config** — the `providers` / `models` / `modelCatalog` / `defaultModel` /
  `thinking` config sections (declared via `useConfigSection`, plus the Kimi
  env overlay),
- **contributions** — `useProvider({ handle, info?, models? })` entries from
  features such as `kimi` (which also contributes its protocol factory via
  `useProviderProtocol`), and
- **credentials** — `CredentialResolvers`, ending in a static env/apiKey
  resolver.

Every model with a live requester is published as a `CatalogModelBinding`
into the `CatalogModels` collection. The app unit exposes two facades:
`ProviderCatalogRef` (snapshot/providers/models/requester/upsert/bind/
remove/refresh/ping/onChanged…) and `ModelDefaultsRef`
(`setDefaultModel(alias)`, `setDefaultThinking(effort)` — both persisted to
config).

**Session level — the default.** A session-scoped feature store holds the
session's default model/thinking (`session.model_defaults` events), exposed
as `SessionModelRef` (`setModel` / `setThinking`); writes are dual-written
into the main agent's binding log so the main agent's undo stays aligned.

**Agent level — the binding.** Each agent keeps its own
`model.bound`-stamped feature store (`AgentModelRef.current` /
`setModel(alias)` / `setThinking(effort)`). A watch computes the effective
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

Because the binding is a turn-stamped feature store, `undoAgentTurns`
rewinds model switches together with the conversation — the model that was
active at the cut turn becomes active again.

## Reading Order for the Runtime Path

1. `src/runtime/agents.ts` — the record, caps, prompt assembly, tool sync.
2. `src/runtime/harness.ts` — the registry, `ensureAgent`, writers.
3. `src/runtime/hooks.ts` — the contribution hooks features call.
4. `src/features/provider-catalog/feature.ts` — managed binding, end to end.
