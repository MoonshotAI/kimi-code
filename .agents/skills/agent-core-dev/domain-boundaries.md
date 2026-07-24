# Topic — Domain boundaries vs Scope

How to keep `agent-core-v2` from recreating a god object after splitting one. Read this before naming a Service, adding an `I{Domain}EntityService`, or deciding whether data belongs to `session`, `agent`, or `turn`.

## The one-sentence rule

> **Scope is a lifetime and visibility boundary; a domain is a responsibility and data-ownership boundary.**

A Service registered at `LifecycleScope.Session` or `LifecycleScope.Agent` is **not automatically in the `session` or `agent` domain**. Scope says when an instance is born, when it dies, and who can see it. Domain says which business responsibility it owns and which data it is allowed to mutate.

## Definitions

| Term | Meaning |
|---|---|
| **Scope** | Lifetime / visibility tier. Current code registers Services at `App`, `Session`, or `Agent`. |
| **Domain** | A cohesive business responsibility with its own model, invariants, and write authority. |
| **Entity** | Data with identity and lifecycle, usually suitable for `get/list/create/update/delete` semantics. |
| **Aggregate** | A consistency boundary: the owner that enforces invariants over a cluster of data. |
| **Read model / projection** | Derived data built for queries; it may be shaped like a domain, but it is not the write authority. |
| **Runtime state** | Ephemeral data that dies with its scope; it should not be forced into an entity store. |

## The data-ownership test

Do not ask "does Session / Agent / Turn use this data?". Most data is used by several of them. Ask these instead:

1. **What is the data's identity?** `sessionId`, `agentId`, `turnId`, `taskId`, `workspaceId`, `providerName`, or something else?
2. **Who is the only writer?** The writer is usually the owner. Readers and projectors are not owners.
3. **Who enforces the invariants?** The domain that decides valid transitions owns the model.
4. **What is the authoritative source?** Atomic document, append-log / event stream, blob, query projection, config, or runtime memory?
5. **Can it be named without `Session` / `Agent` / `Turn`?** If yes, it probably deserves its own domain.

Examples:

- `PermissionRules` are Agent-scoped, but `permission` owns rule changes and evaluation.
- `BackgroundTask` is spawned by an Agent, but `background` owns task state and output.
- `ContextMessage` is consumed by the Agent loop, but `contextMemory` / `wireRecord` owns history and replay.
- `SessionMeta` is about a Session, but it is owned by `sessionMetadata`, not by a broad `session` data bag.

## Persistence models are not all entity CRUD

Before introducing `I{Domain}EntityService`, classify the persistence model:

| Persistence model | Use when | Examples |
|---|---|---|
| **Atomic document** | One typed document per key | `SessionMeta`, `config.toml` |
| **Append-log / event-sourced** | The authoritative record is "what happened" | `wireRecord`, `contextMemory`, `goal`, `plan`, `permission` transitions |
| **Blob / key-value** | Large or content-addressed bytes | media offload, blob store |
| **Indexed query / read model** | Derived, queryable view | `sessionIndex`, future `IQueryStore` projections |
| **Registry / catalog** | Global or scoped known items | `workspace`, `toolRegistry` |
| **Ephemeral runtime state** | No durable entity | active turn handle, pending interactions, terminal handles |

See [persistence.md](persistence.md) for the `Store → Storage → backend` rules. A domain EntityService is a business facade over those stores; it is not a replacement for the store layer.

## Naming consequence

Do not name Services after a scope or a god-object-shaped concept:

- ❌ `IAgentEntityService`
- ❌ `IAgentDataService`
- ❌ `ISessionEntityService`
- ❌ `ITurnEntityService` that bundles context, tools, permissions, and telemetry

Name Services after the real owning domain:

- ✅ `ISessionMetadata`
- ✅ `ISessionIndex`
- ✅ `IAgentLifecycleService`
- ✅ `ITurnService`
- ✅ `IBackgroundTaskEntityService`
- ✅ `ICronTaskEntityService`
- ✅ `IPermissionRulesService`

`Session` and `Agent` are valid scope names. They are usually **not** good data-owner names.

## Split conclusion — `session`

`session` is both a Scope and a narrow Domain. Keep the Domain small.

The `session` domain owns only Session-level identity, metadata, lifecycle commands, and Session-level read views:

| Concern | Owner | Notes |
|---|---|---|
| `sessionId`, `workspaceId`, `sessionDir`, `metaScope` | `sessionContext` | Seeded facts; no IO |
| `SessionMeta` | `sessionMetadata` | Durable atomic document; entity-like |
| Open session scope registry | `sessionLifecycle` | App-scope live handles; not the persisted entity table |
| Session commands such as `archive()` | `session` | Orchestrates metadata, agent teardown, and events |
| Persisted session list / get / count | `sessionIndex` | Backend-neutral read model |
| Running / idle / awaiting status | `sessionActivity` | Derived from interactions and active turns; owns no state |

`session` must not reabsorb these:

| Data | Real owner |
|---|---|
| Agent instances / handles | `agentLifecycle` |
| Turns | `turn` |
| Context messages | `contextMemory` / `wireRecord` |
| Tool state | `toolStore` / `tool` |
| Permission rules / mode | `permission` |
| Profile / model | `profile` |
| Goal / Plan | `goal` / `plan` |
| Background tasks | `background` |
| Cron tasks | `cron` |
| Pending approvals / questions | `interaction` / `approval` / `question` |
| Workspace | `workspace` |
| Provider / config | `provider` / `config` |

Entity-service conclusion for `session`:

- ✅ `ISessionMetadata` is already an entity-document Service.
- ✅ `ISessionIndex` is a query/read-model Service.
- ❌ Do not create a broad `ISessionEntityService` that owns agents, turns, records, interactions, logs, workspace, and config.

## Split conclusion — `agent`

`agent` is primarily a Scope and composition boundary, not a large data Domain.

Strictly, the `agent` domain owns only Agent-instance concerns:

| Concern | Owner | Notes |
|---|---|---|
| Agent instance identity / handle | `agentLifecycle` | Owns live Agent scope handles |
| Agent creation / removal | `agentLifecycle` | Lifecycle, not a data bag |
| Parent / child relationship | `session` / `agentLifecycle` depending on current code | Do not duplicate it into a new Agent data service |
| Active turn reference | `turn` | Turn is its own domain even though it is Agent-scoped |

Many Agent-scoped Services are **not** in the `agent` domain:

| Data / capability | Real owner | Persistence model |
|---|---|---|
| Wire records | `wireRecord` | Append-log |
| Context messages | `contextMemory` | Event-sourced through `wireRecord` |
| Profile / model config | `profile` | Config + wire records |
| Tool definitions / registry | `toolRegistry` | Runtime registry |
| Tool mutable state | `toolStore` | Wire records |
| Permission mode / rules | `permissionMode` / `permissionRules` | Wire records + config |
| Goal | `goal` | Wire records |
| Plan | `plan` | Wire records + plan file |
| Skill activation | `skill` | Wire records |
| Background tasks | `background` | Task records / output logs, candidate for entity service |
| Cron tasks | `cron` | Task records, candidate for entity service |

Entity-service conclusion for `agent`:

- ✅ Keep `IAgentLifecycleService` for Agent instance lifecycle.
- ✅ If a persisted Agent identity registry is ever needed, name it after that narrow concern, e.g. `IAgentInstanceRegistry`.
- ❌ Do not create `IAgentEntityService` or `IAgentDataService` that bundles profile, records, tools, permission, goal, plan, background, cron, and turn.

## Split conclusion — `turn`

`turn` is a Domain, but it is **not** currently a separate `LifecycleScope` in code; `ITurnService` is registered at `Agent` scope.

`turn` owns one execution round's runtime state and turn-level facts:

| Concern | Owner | Notes |
|---|---|---|
| Active `Turn` handle | `turn` | `id`, `abortController`, `ready`, `result` |
| Turn id allocation | `turn` | Restored from `turn.prompt` records and `context.append_loop_event` turn ids |
| Turn lifecycle hooks | `turn` | `onLaunched`, `onEnded`, `beforeStep`, `afterStep` |
| `turn.started` / `turn.ended` live events | `turn` | Live event stream |

`turn` must not own these:

| Data / capability | Real owner |
|---|---|
| Prompt and context messages | `contextMemory` |
| Append-only record log mechanics | `wireRecord` |
| Step loop | `loop` |
| Tool execution | `toolExecutor` / `tool` |
| Permission decisions | `permission` |
| External hook policy | `externalHooks` |
| Telemetry pipeline | `telemetry` |
| Event transport | `eventSink` |

Entity-service conclusion for `turn`:

- ✅ Keep `ITurnService` as a runtime orchestrator.
- ✅ Add a Turn read model / projection only if history queries are needed.
- ❌ Do not create `ITurnEntityService` with `create/update/delete/list` over a turn table as the authoritative model.

## Migration recipe

When moving data out of a v1 god object or reviewing a proposed EntityService:

1. **Name the data without using `Session`, `Agent`, or `Turn`.** If you cannot, the domain is probably unclear.
2. **Find the writer.** The exclusive writer is the likely owner.
3. **Find the invariant.** The Service that rejects invalid transitions owns the model.
4. **Classify the persistence model.** Atomic document, append-log, blob, query projection, registry, or runtime-only.
5. **Pick the Service shape.**
   - Entity document / record → `I{Domain}EntityService` or domain-specific CRUD Service.
   - Event-sourced → behavior Service + `wireRecord` record types + optional projection.
   - Derived query → read-model Service, not a write authority.
   - Runtime-only → scoped Service with no entity store.
6. **Choose the Scope by state identity.** Scope follows what the state is keyed by; it does not decide the domain name.
7. **Render the placement tree** from [design.md §7](design.md#7-render-the-placement-tree).

## Red lines (this topic)

- Scope is not a domain. `Session` / `Agent` scopes do not make data `session` / `agent` owned.
- Ownership follows write authority and invariants, not read consumption.
- Do not create `I{Scope}EntityService` bundles (`IAgentEntityService`, `ISessionEntityService`, `ITurnEntityService`) that re-merge multiple domains.
- Event-sourced domains keep behavior Services and append-log records; do not replace them with arbitrary CRUD.
- Read models may be shaped like a domain, but they are projections, not write authorities.
- A dependency is not ownership. A Service may inject another domain without owning that domain's data.
