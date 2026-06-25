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
 * Owns the session's child-agent set and session-level operations; drives
 * agent lifecycle through `agent-lifecycle`, broadcasts through `event`,
 * persists session metadata through `records`, and records activity through
 * `session-activity`. Bound at Session scope.
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

## Docs

Per-domain references live in `docs/`.

- [`docs/flag.md`](docs/flag.md) — Read **before gating behavior behind a feature flag**: defining/registering a flag in `FLAG_DEFINITIONS`, checking `IFlagService.enabled(id)`, wiring the `[experimental]` config section, or deciding whether a flag is Core-scope vs. per-session.
- [`docs/errors.md`](docs/errors.md) — Read **before raising errors from a domain**: defining a co-located `XxxError`, registering a code in `ErrorCodes`/`ERROR_INFO`, translating external errors (provider/HTTP, fs, MCP) at the boundary, or (de)serializing errors across RPC/SDK with `toErrorPayload`/`fromErrorPayload`.
- [`docs/di-testing.md`](docs/di-testing.md) — Read **before writing or touching any DI/Scope test**: picking the right harness (`InstantiationService` vs `TestInstantiationService` vs `createScopedTestHost`), declaring deps with `@IService`, stubbing collaborators, and teardown via `DisposableStore`.
