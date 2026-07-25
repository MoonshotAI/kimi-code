# Stage 1 — Orient

Understand the DI × Scope black box and the file conventions before touching business code.

## The DI black box

When writing business code you declare three things; the container handles the rest (when to construct, whether it is the same instance, ordering, disposal):

- **Who am I** — an identity that is both a runtime key and a compile-time type.
- **Whom do I need** — the dependencies that provide my capabilities.
- **How long do I live** — which lifetime tier I belong to.

Classes talk only to interfaces and never care how an implementation is constructed.

## The three `LifecycleScope` tiers

Lifetimes form a tree, from longest to shortest:

```text
App (0)         process-wide, single global instance
 └── Session (1)    one session
      └── Agent (2)    one agent
```

```ts
export enum LifecycleScope {
  App = 0,
  Session = 1,
  Agent = 2,
}
```

- A larger number = shorter life = closer to a leaf.
- "Singleton" means **one per scope**: `ILogService` is global once; each `Session` scope has its own `ISessionMetadata`.
- `kind` strictly increases along the parent→child direction.

### Visibility rule

A child scope sees its ancestors; a parent never sees its children. Resolution walks *up* the tree:

- ✅ An `Agent` service injects a `Session` or `App` service (found upward).
- ❌ An `App` service injects a `Session` service (the parent does not look down, and the child may not exist yet).

> **Short-lived may inject long-lived; never the reverse.** The tree structure enforces this — it is not a matter of discipline.

### Disposal order

Deterministic: **child scopes die first; within one scope, instances dispose in reverse construction order** (last constructed, first disposed). Business code declares which tier it lives in and never disposes by hand.

## The `(Ln)` layer number in headers

The `Ln` in a file-header identity line is the domain's **dependency layer** (L0–L7), **not** its `LifecycleScope`. They are easy to confuse because both are small integers, but they answer different questions:

- `LifecycleScope` (App=0 / Session=1 / Agent=2) — **lifetime & visibility** (this stage).
- Dependency layer `Ln` (L0–L7) — **who may import whom**: a domain at layer `L` may import only domains at layer `<= L`. Enforced by `lint:domain` from the authoritative `DOMAIN_LAYER` map in `scripts/check-domain-layers.mjs`.

So a Session-scoped service is not "L1" — e.g. `session` is Session-scoped but lives at **L6**. When you write the header, read the number from the layer map, not from the scope.

| Layer | Role | Representative domains |
|---|---|---|
| L0 | base infrastructure | `_base`, `errors`, `llmProtocol` |
| L1 | bridges & low-level capabilities | `log`, `telemetry`, `event`, `environment`, `bootstrap`, `storage` |
| L2 | data & cross-cutting capabilities | `records`, `wireRecord`, `config`, `provider`, `auth`, `workspace` |
| L3 | registries & capabilities | `tool`, `toolRegistry`, `permission*`, `flag`, `skill`, `plugin` |
| L4 | agent behaviour | `turn`, `loop`, `prompt`, `profile`, `contextMemory`, `goal`, `plan`, `swarm` |
| L5 | async lifecycle | `background`, `mcp`, `cron`, `agentTool` |
| L6 | coordination | `session`, `agentLifecycle`, `sessionMetadata`, `interaction`, `terminal` |
| L7 | boundary / edge | `gateway`, `rpc`, `approval`, `question`, `*Legacy` |

## File-header comment convention

`packages/agent-core-v2/AGENTS.md` mandates a header-only comment style:

- **Header only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. The code is the source of truth for *how*; the header states *what the module exposes and the responsibility it owns*.
- **Identity line first.** Start with `` `<domain>` domain (Ln) — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is. Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list.
- **Scope is in the filename.** `session*.ts` = Session, `agent*.ts` = Agent, no prefix = App (see service-authoring.md). State the same scope in the header so the two never drift.
- **Interface files** (`<name>.ts`) state the public contract + scope: which `IXxx` they define and what it is for.
- **Impl files** (`<name>Service.ts`) add collaborators + scope: list every imported cross-domain collaborator as a role ("persists records through `records`"); read scope from `registerScopedService(LifecycleScope.X, …)`.
- **Contribution files** (`<targetDomain>.ts` / `<what>.contrib.ts`) state what they register into the target domain (e.g. "registers the `log` config section into `config`").
- **Pure-function / `.types` / `.errors` files** state the responsibility only — they own no scoped state, so no scope line.

Impl file example (`sessionMetadataService.ts`):

```ts
/**
 * `sessionMetadata` domain (L6) — `ISessionMetadata` implementation.
 *
 * Persists the session metadata document (`state.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`), rooted at the `metaScope`
 * namespace from `sessionContext`. Loads the existing document on
 * construction (creating it on first run), and logs through `log`. Bound at
 * Session scope.
 */
```

Contribution file example (`config.ts` inside `log/`):

```ts
/**
 * `log` domain — registers the `log` config section into `config`.
 *
 * Owns the `log` section schema and its env overlay; imported for the
 * registration side effect. Bound at App scope.
 */
```

## Red lines (this stage)

- Import via the `#/...` alias (mapped to `src/`); never reach into another domain's internals by relative path.
- Short-lived may inject long-lived; never the reverse.
- File-header comments describe role and scope only; never narrate implementation beside statements.
