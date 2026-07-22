# Service Design Principles

> First-principles guide for designing a new Service in agent-core-v2: how to pick its
> **scope**, when to **split it across scopes**, how to **call** other Services, and which
> direction dependencies should point.
>
> This complements [`docs/di.md`](di.md). `di.md` explains the DI/Scope machinery
> ("how the container works"); this doc explains the **design rules** ("where to put things
> and why"). Read `di.md` first if you have not.

---

## 1. What a Service is

Before discussing scope or calling style, define the object.

**A Service = a bundle of state + a set of behaviors, bound to a lifetime.**

Of these three:

- **Behavior** is almost *free* — the same logic runs anywhere, so it does not by itself
  decide a scope.
- **State** is what pins a Service to a scope. State has an **identity** (what it is keyed
  by) and a **lifetime** (when it is born, when it dies).
- **Dependencies / calling style** answer a different question: **who controls whom, and who
  knows whom**.

Every principle below derives from two root questions:

1. **What is the identity of the state it owns?** → decides the **Scope**.
2. **Who owns the decision, and who needs the result?** → decides the **calling style** and
   the **dependency direction**.

---

## 2. Choosing a Scope

**First principle: Scope = the identity + lifetime of the owned state.**

`App` / `Session` / `Agent` are three tiers of identity + lifetime:

| Scope | State identity (keyed by) | Lifetime |
|---|---|---|
| `App` | none (single global instance) | the process |
| `Session` | `sessionId` | one session |
| `Agent` | `agentId` | one agent |

### Decision tree

**Q1. Does it own mutable state?**

- **No (pure behavior)** → jump to Q3.
- **Yes** → Q2.

**Q2. What is the identity of that state?**

- one global instance → **`App`**
- one per session → **`Session`**
- one per agent → **`Agent`**
- a mix (a global registry *and* per-instance state) → **do not put it in one Service;
  split it** (see §3 Multi-Scope).

**Q3 (stateless). What is the shortest-lived dependency it must inject?**

A stateless Service is pulled *down* by its shortest-lived dependency: if it injects an
`Agent`-scoped Service, it cannot be `App`. Among the scopes that still satisfy every
dependency, **default to the longest-lived one** (usually `App`) to maximize reuse and
singleton sharing. Push it down only when:

1. it must inject a shorter-lived Service (enforced by the container); or
2. you want to limit its visibility (it conceptually belongs to one agent and should not be
   globally exposed).

### The core anti-pattern (a litmus test)

> **Do not store per-session state in a `Map<sessionId, …>` inside a `App` Service.**

This is the tell-tale sign of "this should have been `Session`-scoped but was lazily parked
at `App`". Consequences:

- nobody cleans the entry up when the session ends → **leak**;
- every consumer threads `sessionId` around → **loss of type safety**;
- it cannot inject `Session`/`Agent`-scoped collaborators.

### One-sentence self-check

> **"When this scope is disposed, should this state disappear with it?"**
>
> - Yes → the scope is right.
> - It must outlive the scope → the scope is too short; move up one tier.
> - It should be one-per-unit but is being shared → the scope is too long; move down one tier.

---

## 3. Multi-Scope splitting

**First principle: one Service owns state at exactly one identity / lifetime. If a domain
owns state at several lifetimes, split it along those lifetime boundaries — one Service per
lifetime.**

This is not layered-architecture aesthetics; it is forced by state identity. A class that
holds both "a global registry" and "per-session instances" will either leak (the global part
keeps per-session entries alive) or get pinned to an awkward scope where it can do neither
job well.

### The standard split: "global registry / factory" + "per-instance"

| Tier | Role | Naming tends to |
|---|---|---|
| `App` | **global registry / catalog / factory** — knows "all of them" and how to create one | `XxxStore` / `XxxRegistry` / `XxxCatalog` |
| `Session` / `Agent` | **one instance** — only the state of "this one" | `XxxService` / `ISessionXxx` / `IAgentXxx` |

This pattern recurs throughout the codebase and confirms the rule:

- **`records`** — `ISessionIndex` (`App`, read model of all persisted sessions) +
  `ISessionMetadata` (`Session`, this session's metadata) + `IAgentWireRecordService` (`Agent`, this
  agent's record stream).
- **`config`** — `IConfigRegistry` / `IConfigService` (`App`, global config).
- **`chatProvider` / `model` / `modelRuntime`** — `IChatProviderFactory` (`App`,
  protocol adapters keyed by provider type), `IModelService` (`App`, model-alias
  configuration), and `IModelResolver` (`Session`, resolves the active model into a
  runtime provider config plus request authorization). Provider connection
  configuration lives in the sibling `provider` domain (`IProviderService`, `App`).
  Generation itself is driven by `IAgentLLMRequesterService` (`Agent`) in the `llmRequester`
  domain.
- **`tool`** — `IToolDefinitionRegistry` (`App`, tool-definition registry) + `IToolService`
  (`Agent`, this agent's execution).

### When to split and when not to

- **Split** when the domain genuinely has both a global view and per-instance state.
- **Do not split** when the domain has state at only one lifetime (e.g. purely `App` like
  `log` / `telemetry`; purely `Agent` like `prompt`). **Do not pre-split for symmetry.**

### Dependency direction after the split

The `App` Service usually plays the **factory**: it knows how to create or locate the
per-instance one. Most consumers inject the **per-instance** Service, because it serves the
current session/agent directly without threading an id. Inject the `App` factory only when
you genuinely need cross-instance management.

---

## 4. Choosing a calling style

There are three ways for one Service to make another act: a **direct call** (DI injection),
an **event**, or a **hook**. From first principles, they answer three different questions.

**First principle: the choice depends on "who owns the decision" + "is a result needed" +
"how many consumers".**

### What the three mechanisms mean

| Mechanism | Nature | Coupling | Returns a value? | Consumers |
|---|---|---|---|---|
| **Direct call** | command: A tells B to do | A → B | yes | one (known) |
| **Event** | fact: A announces "X happened" | both depend only on the bus | no | zero / one / many (unknown) |
| **Veto event** (`onBefore*`) | interception: listeners adjudicate through the event object (`veto` / `allow` / `pass` / `waitUntil`), no ids and no ordering contract | both depend only on the bus | veto result (first wins) | many, unordered |
| **Hook** (`onWill` / `onDid`, `OrderedHookSlot`) | participation: observers step into an operation, in order | both depend only on the bus | can observe / veto | many, but ordered |

Use a veto event when many domains may intercept an operation and the only outcomes are "deny / short-circuit / let through" (e.g. `toolExecutor.onBeforeExecuteTool`): the fire side collects immediate statements first, then fulfills deferred (`waitUntil`) adjudications, so a hard deny always suppresses approval round-trips. Use an ordered hook when the *sequence* between participants is itself meaningful (result pipelines like `onDidExecuteTool`, step lifecycle like `onWillBeginStep` / `onDidFinishStep`).

### Decision tree

**Q1. Does A need a return value from B?**

- Yes → **direct call**. Events cannot return a value (doing request/reply over events is an
  anti-pattern).

**Q2. Is B's reaction part of A's responsibility, or B's own concern?**

- A's responsibility *includes* B's behavior (A orchestrates B) → **direct call**. E.g.
  `session` drives `agentLifecycle`; `loop` drives `llmRequester` / `toolExecutor` — that
  *is* their job.
- B's reaction is B's own concern, and A is merely **stating a fact** → **event**. E.g.
  `flag` reacts to `config.onDidChangeConfiguration`; `config` does not know who is listening.

**Q3. How many consumers?**

- exactly one, and known → **direct call**.
- zero / one / many, and the producer should not know how many → **event**.

**Q4. Would a direct A→B call create a cycle or violate the scope direction?**

- This is a **consequence check**, not a primary reason. Decide by Q1–Q3 first; if the
  semantics already call for an event, the decoupling comes for free. Do not turn a genuine
  direct call into an event just to break a cycle.

**Q5. Is this fact part of the durable record / replay / cross-agent projection?**

- Yes → **emit it on the wire** (`wireRecord`). This is a system-specific but strong reason:
  state changes that must be recorded, replayed, or synchronized across agents have to be
  projected onto the wire, not handled by a direct call alone. `permission.set_mode`,
  `goal.create/update/clear`, and `plan_mode.enter/exit` are all in this category.
  Note that the wire is the *durable record*, not the live notification channel: a live
  context mutation appends v1 wire records (`context.append_message` /
  `context.append_loop_event` / `context.undo` / `context.clear` /
  `context.apply_compaction`) *and* applies them, and `contextMemory` then fires a
  `context.spliced` event, which `contextSize` / `loop` / `background` / `dynamicInjector`
  actually subscribe to. Those listeners react to the **event**, not the wire — the wire is
  what makes the mutation replayable.

### One-sentence rule

> **"I am telling you to do this, and I may need the result" → direct call.**
> **"I am announcing that something happened; react if you care" → event.**
> **"I am about to do something; you may veto it, in no particular order" → veto event.**
> **"I am announcing something, and you may step in, in order, possibly to veto" → hook.**

---

## 5. Dependency direction

Two distinct layers are involved, and they differ in *hardness*:

- **Scope direction**: short-lived → long-lived, **enforced by the container** (already
  covered in [`docs/di.md`](di.md)).
- **Domain direction**: which domain may depend on which, **a matter of judgment** — the
  container does not enforce it.

### First principle: dependency direction = the direction of "needs to know"

> **A depends on B iff A needs B's data or behavior to do its own job.**

That is the whole rule. `prompt` depending on `turn` (as it does today) is legitimate —
the prompt needs the turn's information to be built. `loop` depending on many capabilities
is legitimate — orchestration *is* its job.

This rule alone is not enough; add one anti-rot heuristic to keep the graph from collapsing
into a clique:

> **Do not let a more foundational / more-reused Service come to know a more specific /
> more-upstream one.**

Reason: reuse gets inverted — once a foundational component knows about an upstream
scenario, it can no longer be reused by other scenarios, and it will almost always create a
cycle.

### The natural layers of this repo

Derived from "what is more foundational", roughly (lower is depended on by higher, never the
reverse):

1. **Root (depend on no business domain)**: `_base`, `log`, `environment`, `event`,
   `telemetry`, `kaos`.
2. **Data / state**: `records`, `filestore`, `workspace`, `blobStore`, `config`.
3. **Capabilities**: `tool`, `permission`, `prompt`, `contextMemory`, `chatProvider`,
   `modelRuntime`, `skill`, …
4. **Orchestrators**: `session`, `agentLifecycle`, `loop`, `turn`, `swarm`.
5. **Edge**: `gateway`, `rpc`.

**Red lines:**

- Layer 1 (root) **never** depends on any business domain.
- Business logic does **not** depend on layer 5 (edge) — business code should not know REST /
  WebSocket exist.
- A cycle means knowledge was placed the wrong way around. Fix it (consistent with `di.md`
  scenario 9): extract a third, more foundational Service, or invert the "notification" half
  into an event.

> Note: capability → orchestrator (e.g. `prompt → turn`) is **allowed and present** in this
> repo; do not treat it as a red line. The real red line is *inverted reuse* — a
> foundational / lower Service depending on a specific / upper one.

---

## 6. Putting it together

The complete checklist for a new `IXxxService`:

1. **What does it remember, and what is the state's identity?** → pick the scope (§2).
2. **What is the shortest-lived dependency it must inject?** → the scope cannot be longer
   than that.
3. **Does it own state at both a global and a per-instance lifetime?** → if yes, split it
   Multi-Scope (§3).
4. **For each collaborator: am I commanding it, notifying it, or letting it participate?**
   → pick the calling style (§4).
5. **Does each dependency arrow make a more foundational thing know a more specific thing?**
   → if yes, invert it (§5).

---

## 7. Summary

- **Scope**: the **identity** of the state fixes the scope; do not fake per-instance state
  at `App` with a `Map<id, …>`.
- **Multi-Scope**: a domain with state at several lifetimes → split into "a `App` registry
  + per-instance Services".
- **Calling style**: need a result / I orchestrate → direct call; stating a fact / react if
  you care → event; ordered participation / may veto → hook.
- **Dependency direction**: arrows follow "needs to know", but never let a foundational layer
  know an upstream one; a cycle means knowledge is placed backwards.
