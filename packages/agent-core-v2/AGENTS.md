# agent-core-v2 Agent Guide

> New agent engine built on the DI Scope architecture — work-in-progress port of `packages/agent-core`. Design: `plan/PLAN.md`. Porting status: `GAP_ANALYSIS.md`.

## Comment conventions

- **Header only, external role only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. Say what the module exposes and the responsibility it owns; the code is the source of truth for how it works, so do not narrate implementation steps, enumerate every export, or note porting / skeleton status.
- **Identity line first.** Start with `` `<domain>` domain (Ln) — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is; barrels omit the layer (`` `<domain>` domain barrel — … ``). Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list ("turn driver + context + loop runner").
- **Impl files add collaborators + scope; contract files add the public contract + scope.** For impls, list every imported cross-domain collaborator as a role ("persists records through `records`") — declared dependencies count even if not yet wired in this WIP port; infrastructure imports (`_base/**`) are not collaborators. Read scope from `registerScopedService(LifecycleScope.X, …)`.

### Examples

Impl (`src/session/sessionService.ts`):

```ts
/**
 * `session` domain (L6) — `ISessionService` implementation.
 *
 * Runs session-level commands; reads its identity through `session-context`,
 * mutates metadata through `session-metadata`, drives agent teardown through
 * `agent-lifecycle`, and broadcasts through `event`. Bound at Session scope.
 */
```

Barrel (`src/session/index.ts`):

```ts
/**
 * `session` domain barrel — re-exports the session facade contract
 * (`session`) and its scoped service (`sessionService`). Importing this
 * barrel registers the `ISessionService` binding into the scope registry.
 */
```

## Persistence

Business domains **do not implement persistence themselves** — they depend on a Service that owns the access pattern. Business code expresses *what* to store or fetch, never *how*.

- Append-log → `IAppendLogStore`
- Atomic document → `IAtomicDocumentStore`
- Blob → `IBlobStore`
- Domain-specific query → a dedicated Store (e.g. `ISessionIndex`)

Business code must not `import 'node:fs'`, write SQL, hand-roll append-logs / atomic writes, or hold file handles. Generic Stores are named by **access pattern** (`IAppendLogStore`, `IAtomicDocumentStore`); only domain-unique Stores are named after the domain (`ISessionIndex`). See `.agents/skills/agent-core-dev/persistence.md` for the full layering rules and decision tree.

## Docs

Per-domain references live in `docs/`.

- [`docs/di.md`](docs/di.md) — Read **before adding any business capability**: a scenario-driven walkthrough of the DI × Scope black box, from "add a global service" through dependency injection, scope selection, disposal, delayed/eager instantiation, `invokeFunction`, `createInstance`, child scopes, and cycles — introducing each concept only as the scenario needs it.
- [`docs/service-design.md`](docs/service-design.md) — Read **before designing a new Service**: first-principles rules for choosing a scope, splitting a domain Multi-Scope, picking a calling style (direct call vs event vs hook), and directing dependencies — the design companion to `docs/di.md`.
- [`docs/flag.md`](docs/flag.md) — Read **before gating behavior behind a feature flag**: declaring a flag in its owning domain and registering it at import time via `registerFlagDefinition`, checking `IFlagService.enabled(id)`, wiring the `[experimental]` config section, or deciding whether a flag is Core-scope vs. per-session.
- [`docs/errors.md`](docs/errors.md) — Read **before raising errors from a domain**: defining a co-located `XxxError`, registering a code in `ErrorCodes`/`ERROR_INFO`, translating external errors (provider/HTTP, fs, MCP) at the boundary, or (de)serializing errors across RPC/SDK with `toErrorPayload`/`fromErrorPayload`.
- [`docs/di-testing.md`](docs/di-testing.md) — Read **before writing or touching any DI/Scope test**: picking the right harness (`InstantiationService` vs `TestInstantiationService` vs `createScopedTestHost`), declaring deps with `@IService`, stubbing collaborators, and teardown via `DisposableStore`.
- [`docs/di-scope-domains.puml`](docs/di-scope-domains.puml) — DI Scope × Domain dependency map (node color = `LifecycleScope`; solid edges = constructor DI injection, dashed edges = `wireRecord` / event-driven). **When adding a Service or changing the dependency relationships between Services, update this puml and regenerate `docs/di-scope-domains.svg`**.
