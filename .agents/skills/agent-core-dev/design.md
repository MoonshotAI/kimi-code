# Stage 2 — Design a service

Decide *where things live and who knows whom* before writing code. Every rule here derives from two questions:

1. **What is the identity of the state it owns?** → decides the **Scope**.
2. **Who owns the decision, and who needs the result?** → decides the **calling style** and **dependency direction**.

## 1. What a Service is

A Service = a bundle of **state** + a set of **behaviors**, bound to a **lifetime**.

- **Behavior** is almost free — the same logic runs anywhere, so it does not by itself decide a scope.
- **State** pins a Service to a scope. State has an **identity** (what it is keyed by) and a **lifetime** (when it is born, when it dies).
- **Dependencies / calling style** answer a different question: who controls whom, and who knows whom.

## 2. Choosing a scope

> Scope = the identity + lifetime of the owned state.

| Scope | State identity (keyed by) | Lifetime |
|---|---|---|
| `App` | none (single global instance) | the process |
| `Session` | `sessionId` | one session |
| `Agent` | `agentId` | one agent |

### Decision tree

**Q1. Does it own mutable state?**

- No (pure behavior) → jump to Q3.
- Yes → Q2.

**Q2. What is the identity of that state?**

- one global instance → **`App`**
- one per session → **`Session`**
- one per agent → **`Agent`**
- a mix (a global registry *and* per-instance state) → **split it** (see §3).

**Q3 (stateless). What is the shortest-lived dependency it must inject?**

A stateless Service is pulled *down* by its shortest-lived dependency: if it injects an `Agent`-scoped Service, it cannot be `App`. Among the scopes that still satisfy every dependency, **default to the longest-lived one** (usually `App`) to maximize reuse. Push it down only when it must inject a shorter-lived Service, or when you want to limit its visibility.

### The core anti-pattern (a litmus test)

> **Do not store per-session state in a `Map<sessionId, …>` inside an `App` Service.**

This is the tell-tale sign of "should have been `Session`-scoped but was parked at `App`". Consequences: nobody cleans the entry up when the session ends (leak); every consumer threads `sessionId` around (loss of type safety); it cannot inject `Session`/`Agent`-scoped collaborators.

### One-sentence self-check

> "When this scope is disposed, should this state disappear with it?"
>
> - Yes → the scope is right.
> - It must outlive the scope → too short; move up one tier.
> - It should be one-per-unit but is shared → too long; move down one tier.

## Scope is not a domain

Scope answers **lifetime and visibility**. Domain answers **responsibility and data ownership**. A Service registered at `Session` or `Agent` scope is not automatically part of the `session` or `agent` domain, and an entity Service must not be named `I{Scope}EntityService` just because its data is scoped that way.

Use the data-ownership test and the `session` / `agent` / `turn` split conclusions in [domain-boundaries.md](domain-boundaries.md) before naming a Service or adding `I{Domain}EntityService`.

## 3. Multi-Scope splitting

> One Service owns state at exactly one identity / lifetime. If a domain owns state at several lifetimes, split it along those boundaries — one Service per lifetime.

The standard split is "global registry / factory" + "per-instance":

| Tier | Role | Naming tends to |
|---|---|---|
| `App` | global registry / catalog / factory — knows "all of them" and how to create one | `XxxStore` / `XxxRegistry` / `XxxCatalog` |
| `Session` / `Agent` | one instance — only the state of "this one" | `XxxService` / `ISessionXxx` / `IAgentXxx` |

Canonical splits in the codebase:

- **`records`** — `ISessionStore` (`App`) + `ISessionMetaStore` (`Session`) + `IAgentRecords` (`Agent`).
- **`config`** — `IConfigRegistry` / `IConfigService` (`App`).
- **`kosong`** — `IProtocolHandlerRegistry` (`App`) + `IProviderManager` (`Session`). Generation is driven by `ILLMRequester` (`Agent`) in the `llmRequester` domain.
- **`tool`** — `IToolDefinitionRegistry` (`App`) + `IToolService` (`Agent`).

Split when the domain genuinely has both a global view and per-instance state. Do **not** split when state lives at only one lifetime (e.g. purely `App` like `log`; purely `Agent` like `prompt`). Do not pre-split for symmetry.

After the split, the `App` Service usually plays the **factory**; most consumers inject the **per-instance** Service. Inject the `App` factory only when you genuinely need cross-instance management.

## 4. Choosing a calling style

Three mechanisms answer three different questions:

| Mechanism | Nature | Coupling | Returns a value? | Consumers |
|---|---|---|---|---|
| **Direct call** | command: A tells B to do | A → B | yes | one (known) |
| **Event** | fact: A announces "X happened" | both depend only on the bus | no | zero / one / many (unknown) |
| **Hook** (`onWill` / `onDid`, `OrderedHookSlot`) | participation: observers step into an operation, in order | both depend only on the bus | can observe / veto | many, but ordered |

### Decision tree

**Q1. Does A need a return value from B?** → Yes: **direct call**. Events cannot return a value (request/reply over events is an anti-pattern).

**Q2. Is B's reaction part of A's responsibility, or B's own concern?**

- A's responsibility *includes* B's behavior (A orchestrates B) → **direct call**. E.g. `session` drives `agentLifecycle`; `loop` drives `llmRequester` / `toolExecutor`.
- B's reaction is B's own concern, A merely states a fact → **event**. E.g. `flag` reacts to `config.onDidChange`.

**Q3. How many consumers?**

- exactly one, known → **direct call**.
- zero / one / many, producer should not know → **event**.

**Q4. Would a direct A→B call create a cycle or violate scope direction?** → A *consequence check*, not a primary reason. Decide by Q1–Q3 first; do not turn a genuine direct call into an event just to break a cycle.

**Q5. Is this fact part of the durable record / replay / cross-agent projection?** → Yes: **emit it on the wire** (`wireRecord`). State changes that must be recorded, replayed, or synchronized across agents are projected onto the wire, not handled by a direct call alone (`permission.set_mode`, `goal.create/update/clear`, `plan_mode.enter/exit`). The wire is the *durable record*, not the live notification channel.

### One-sentence rule

> "I am telling you to do this, and I may need the result" → **direct call.**
> "I am announcing that something happened; react if you care" → **event.**
> "I am announcing something, and you may step in, in order, possibly to veto" → **hook.**

### As extension points (open-closed)

The three mechanisms above are also where a domain accepts new behavior without being edited. When adding a scenario would otherwise require changing this domain's `if/else`, expose the right extension point instead:

| Need | Extension point | Typical scope |
|---|---|---|
| Register a new implementation / definition | a **registry / catalog** the domain queries | `App` |
| React to a fact the domain announces | an **event** on the bus | the announcing scope |
| Step into an operation in order / veto | a **hook** (`onWill`/`onDid`, `OrderedHookSlot`) | the owning scope |
| Swap a backend (File ↔ DB ↔ S3) | a **Store / Storage token** at the byte layer (see persistence.md) | `App` (composition root) |

Closed-for-modification means: the domain's own file is not where new scenarios branch. If a new scenario forces an edit here, an extension point is missing or misplaced.

## 5. Dependency direction

Two layers are involved:

- **Scope direction**: short-lived → long-lived, **enforced by the container** (see orient.md).
- **Domain direction**: which domain may depend on which — **a matter of judgment**, not enforced by the container.

> **A depends on B iff A needs B's data or behavior to do its own job.**

Add one anti-rot heuristic to keep the graph from collapsing into a clique:

> **Do not let a more foundational / more-reused Service come to know a more specific / more-upstream one.**

Once a foundational component knows about an upstream scenario, it can no longer be reused by other scenarios and will almost always create a cycle.

### The natural layers of this repo

`agent-core-v2` is stratified into eight dependency layers, **L0–L7** (the `Ln` number in file headers — see orient.md for the full table and the representative domains). A domain at layer `L` may import only domains at layer `<= L`; lower layers never reach upward. `lint:domain` enforces this from the `DOMAIN_LAYER` map in `scripts/check-domain-layers.mjs`.

The tiers, from lowest to highest:

- **L0 — base infrastructure** (`_base`, errors, wire types).
- **L1 — bridges & low-level capabilities** (logging, telemetry, event bus, environment, storage).
- **L2 — data & cross-cutting capabilities** (records, config, providers, auth, workspace registry).
- **L3 — registries & capabilities** (tools, permissions, flags, skills, plugins).
- **L4 — agent behaviour** (turn, loop, prompt, profile, context, goal, plan, swarm).
- **L5 — async lifecycle** (background, MCP, cron, sub-agent tools).
- **L6 — coordination** (session, agent/session lifecycle, interactions, terminal).
- **L7 — boundary / edge** (`gateway`, `rpc`, approval/question, the `*Legacy` v1 adapters).

Red lines:

- The **L0/L1 substrate** never imports a higher business layer.
- Business logic never depends on the **L7 edge** layer — business code should not know REST / WebSocket exist.
- A cycle means knowledge was placed backwards: extract a third, more foundational Service, or invert the "notification" half into an event.

> Capability → orchestrator (e.g. `prompt → turn`) is allowed and present in this repo; the real red line is *inverted reuse* — a foundational / lower Service depending on a specific / upper one.

> When a Service is meant to be reached over the wire (`/api/v2`, WS), see [edge-exposure.md](edge-exposure.md) for the per-scope `resource:action` map, which Services may be exposed directly vs wrapped in a facade, and how events stream.

## 6. New-Service checklist

1. **What does it remember, and what is the state's identity?** → pick the scope (§2).
2. **What is the shortest-lived dependency it must inject?** → the scope cannot be longer than that.
3. **Does it own state at both a global and a per-instance lifetime?** → if yes, split Multi-Scope (§3).
4. **For each collaborator: am I commanding it, notifying it, or letting it participate?** → pick the calling style (§4).
5. **Does each dependency arrow make a more foundational thing know a more specific thing?** → if yes, invert it (§5).

## 7. Render the placement tree

After the checklist, render the result as a plaintext tree — the deliverable reviewers read. Keep it in the design doc or PR description.

```text
domain: `<name>`   (owning scope: <Scope>)
├─ serves (who uses me)              tag = HOW they reach me
│   ├─ (inject)   <ConsumerDomain>   @<Scope>   — <what they use me for>
│   └─ (accessor) <ConsumerDomain>   @<Scope>   — <what they use me for>
├─ exposes (interfaces I provide, by scope)
│   ├─ App       : <IXxxRegistry>   — <role>
│   ├─ Session  : <ISessionXxx>    — <role>
│   └─ Agent    : <IAgentXxx>      — <role>
└─ depends (what I inject)           tag = calling style
    └─ <DepDomain>  @<Scope>   direct/event/hook  — <what for>
```

Conventions:

- List **only real interfaces**; write `—` for a scope with no exposed interface. Most domains are single-scope — do not invent symmetry.
- On `depends`, tag each arrow with its calling style: `direct`, `event`, or `hook`.
- On `serves`, tag each consumer with its **access mechanism**, grouped `inject` first then `accessor`:
  - `inject` — a descendant or peer scope DI-injects me. Resolved by the container; lifetime-safe.
  - `accessor` — an ancestor or edge scope borrows me through `IScopeHandle.accessor.get(...)`. Valid only while this scope lives; never cache the result; must run before the child scope is disposed. See the cross-scope borrow diagram below.
- An empty `(inject)` group with a non-empty `(accessor)` group is a signal: the interface is currently an edge / lifecycle command surface — check it is not leaking internals.
- A consumer is upstream of you. If you cannot name one business consumer, the domain may be dead or mis-scoped.

### Cross-scope borrow diagram

When a domain has `accessor` consumers, draw the reverse-direction borrow next to the tree so it is never mistaken for injection:

```text
App scope
  <AncestorService> ──holds──► IScopeHandle(<id>)
                                      │
                                      │  accessor.get(<IMyService>)
                                      │   └── resolve runs inside the child scope
                                      ▼
                                <Child> scope (<id>)
                                  <MyService>  ← the interface lives here
```

Read it as:

- `──holds──►` = the ancestor owns a handle to the child scope (it stores the key, not the service). DI allows this.
- `accessor.get(...)` = a **runtime borrow**, not a dependency edge. It must cross an `IScopeHandle`, run on demand, never be cached, and finish before the child scope is disposed.

Worked example — `sessionLifecycle`:

```text
domain: `sessionLifecycle`   (owning scope: App)
├─ serves (who uses me)
│   ├─ (inject)   — (none yet)
│   └─ (accessor)
│       ├─ sessionLegacy     @App(edge)  — v1-compatible create/fork/archive/…
│       └─ gateway / rpc     @App(edge)  — native v2 session lifecycle actions
├─ exposes (interfaces I provide, by scope)
│   ├─ App       : ISessionLifecycleService — owns the live session scope tree
│   ├─ Session   : —                    — (per-session state lives in sessionMetadata / agentLifecycle / …)
│   └─ Agent     : —                    — (per-agent state lives in agentLifecycle)
└─ depends (what I inject)
    ├─ bootstrap         @App  direct  — addresses session storage
    ├─ hostEnvironment   @App  direct  — gates scope creation on the probe
    ├─ sessionIndex      @App  direct  — persisted read model for cold resumes
    ├─ storage           @App  direct  — atomic docs + append logs
    ├─ workspace        @App  direct  — resolves a session's workspace
    └─ event             @App  direct  — broadcasts session-level facts (e.g. archived)
```

Cross-scope borrow for `sessionLifecycle`:

```text
App scope
  SessionLifecycleService ──holds──┐
  GatewayService ───────────holds──┼──► IScopeHandle(sessionId)
                                        │
                                        │  accessor.get(ISessionMetadata) …
                                        │   └── resolve runs inside the Session scope
                                        ▼
                                  Session scope (sessionId)
                                    sessionMetadata / agentLifecycle / …  ← per-session services live here
```

How the three lenses shaped it:

- **Scope (§2)** → the live registry of session scopes is process-wide, so it is App-scoped; per-session data stays in Session-scoped services, reached through the handle's `accessor`.
- **Dependency direction (§5)** → `sessionLifecycle` is consumed by the edge via `accessor` borrows; it never imports the edge. Every downward arrow lands on a peer or a more foundational Service.
- **Extension points (§4)** → new per-session behavior plugs into the Session-scoped services (`sessionMetadata`, `agentLifecycle`, `sessionActivity`); new transports stay at the edge. Neither edits `sessionLifecycle`.

For a multi-scope split, the `exposes` block fills more than one scope — see the `records` pattern in §3.

## Red lines (this stage)

- Scope is not a domain; ownership follows write authority and invariants, not read consumption.
- Do not create `I{Scope}EntityService` bundles (`IAgentEntityService`, `ISessionEntityService`) that re-merge multiple domains.
- No `Map<sessionId, …>` at `App` to fake per-session state.
- Scope follows state identity; stateless Services are pulled down by their shortest-lived dependency, otherwise default to `App`.
- Do not pre-split a domain that has state at only one lifetime.
- Need a result / I orchestrate → direct call; stating a fact → event; ordered participation / may veto → hook.
- Foundational layers never know upstream ones; business code never depends on the edge layer.
- A cycle means knowledge is placed backwards — refactor, do not route around it.
- Render the placement tree with real interfaces only — never pad an empty scope for symmetry.
- Tag `serves` consumers with `inject` / `accessor`; an empty `inject` group is a signal to check the interface is not leaking internals.
- An `accessor` consumer is a runtime borrow across a scope boundary, not DI injection — never cache the result and finish before the child scope disposes.
- A `serves` list with no business consumer (or only edge consumers) signals a dead or leaking interface.
