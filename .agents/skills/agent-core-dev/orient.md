# Stage 1 — Orient

Understand the DI × Scope black box and the file conventions before touching business code.

## The DI black box

When writing business code you declare three things; the container handles the rest (when to construct, whether it is the same instance, ordering, disposal):

- **Who am I** — an identity that is both a runtime key and a compile-time type.
- **Whom do I need** — the dependencies that provide my capabilities.
- **How long do I live** — which lifetime tier I belong to.

Classes talk only to interfaces and never care how an implementation is constructed.

## The four `LifecycleScope` tiers

Lifetimes form a tree, from longest to shortest:

```text
App                 process-wide, single global instance
 └── Workspace        one workspace handler (a materialized workspace root)
      └── Session       one session
           └── Agent      one agent
```

```ts
// src/app/scopes.ts — the business layer declares the tiers and their order;
// the DI kernel only knows opaque string kinds plus the declared topology.
export enum LifecycleScope {
  App = 'app',
  Workspace = 'workspace',
  Session = 'session',
  Agent = 'agent',
}
```

- Later in the topology = shorter life = closer to a leaf.
- "Singleton" means **one per scope**: `ILogService` is global once; each `Session` scope has its own `ISessionMetadata`.
- `kind` must advance along the declared topology in the parent→child direction.

### Visibility rule

A child scope sees its ancestors; a parent never sees its children. Resolution walks *up* the tree:

- ✅ An `Agent` service injects a `Session` or `App` service (found upward).
- ❌ An `App` service injects a `Session` service (the parent does not look down, and the child may not exist yet).

> **Short-lived may inject long-lived; never the reverse.** The tree structure enforces this — it is not a matter of discipline.

### Disposal order

Deterministic: **child scopes die first; within one scope, teardown runs in strict reverse registration order, one entry at a time.** The mechanism is the Ledger (`src/_base/lifecycle/`): ordered effect bookkeeping, dual-track (sync + async disposers), serial reverse-order teardown (never parallel), with the teardown reason (`'scope-close' | 'cascade' | 'unload'`) passed through to every disposer. `Disposable` / `DisposableStore` (`src/_base/di/lifecycle.ts`) delegate to it — "reverse construction order" is a Ledger property, not a container convention. Business code declares which tier it lives in and never disposes by hand.

## Dynamic DI: units and cascades

Registration is not the end of the story. Every unit a container tracks — static registrations and runtime `provide`s alike — lives in a small state machine owned by the scope's cascade engine (`src/_base/di/cascadeEngine.ts`, one per scope container, orchestrating tree-wide). Vocabulary you will meet in errors, tests, and the debug surface:

- **Unit states** — `Pending → Activating → Active`, plus `Unloading` during teardown and a sticky `Failed`. A construction failure parks the unit in `Failed` with no auto-retry: resolving it rethrows its error; an explicit `update()` reloads it.
- **Waiting area** — a unit whose declared dependencies are missing sits `Pending` and auto-activates when they arrive, including cross-scope wake-up when an ancestor gains the token. An `ondemand` unit counts as available: consumers pull it transitively at materialization.
- **Cascade transaction** — every `provide` / `unprovide` / `update` runs as one tree-wide transaction: contagion set from the persistent dependency graph (instance edges, child→parent across scopes) → abort hook → global reverse-topo teardown → apply the change → waiting-area recheck fixpoint → history ring. Static bootstrap shares this path: scope creation submits the kind's whole registration batch as one `provideAll`, so registration order never matters.

## Import boundaries

There is no domain-layer numbering — a domain may import any other domain, guided by the dependency-direction judgment in design.md. The only mechanically enforced import boundaries are (`lint:imports`, `scripts/check-import-boundaries.mjs`):

- v2 never imports v1 (`@moonshot-ai/agent-core` or any subpath).
- The kosong subtree (`src/kosong/{contract,protocol,provider,model}`) keeps its strict internal order (`contract ← protocol ← provider/model`), purity bans (no SDKs in `contract`/`protocol`), and the `provider/bases` registration boundary.

## File-header comment convention

`packages/agent-core-v2/AGENTS.md` mandates a header-only comment style:

- **Header only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. The code is the source of truth for *how*; the header states *what the module exposes and the responsibility it owns*.
- **Identity line first.** Start with `` `<domain>` domain — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is. Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list.
- **Scope is in the filename.** `workspace*.ts` = Workspace, `session*.ts` = Session, `agent*.ts` = Agent, no prefix = App (see service-authoring.md). State the same scope in the header so the two never drift.
- **Interface files** (`<name>.ts`) state the public contract + scope: which `IXxx` they define and what it is for.
- **Impl files** (`<name>Service.ts`) add collaborators + scope: list every imported cross-domain collaborator as a role ("persists records through `records`"); read scope from `registerScopedService(LifecycleScope.X, …)`.
- **Contribution files** (`<targetDomain>.ts` / `<what>.contrib.ts`) state what they register into the target domain (e.g. "registers the `log` config section into `config`").
- **Pure-function / `.types` / `.errors` files** state the responsibility only — they own no scoped state, so no scope line.

Impl file example (`sessionMetadataService.ts`):

```ts
/**
 * `sessionMetadata` domain — `ISessionMetadata` implementation.
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
