# agent-core-v2 Agent Guide

> New agent engine built on the DI Scope architecture — work-in-progress port of `packages/agent-core`. Design: `plan/PLAN.md`. Porting status: `GAP_ANALYSIS.md`.

## Examples

> The runnable examples have moved to the standalone `kimi-code-mini-bench` package at `../kimi-code-mini-bench`. They are wired to `agent-core-v2` through a pnpm `link:` dependency and run as a separate Vitest project.

Domain-slice scenarios that used to live in `examples/<name>.example.ts` are now maintained there. Each `*.example.ts` exercises one subset of domains end-to-end, builds its own container, runs its slice's services for real, and stubs collaborators outside the slice. See `../kimi-code-mini-bench/README.md` for how to run them.

## Comment conventions

- **Header only, external role only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. Say what the module exposes and the responsibility it owns; the code is the source of truth for how it works, so do not narrate implementation steps, enumerate every export, or note porting / skeleton status.
- **Identity line first.** Start with `` `<domain>` domain (Ln) — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is. Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list ("turn driver + context + loop runner").
- **Impl files add collaborators + scope; contract files add the public contract + scope.** For impls, list every imported cross-domain collaborator as a role ("persists records through `records`") — declared dependencies count even if not yet wired in this WIP port; infrastructure imports (`_base/**`) are not collaborators. Read scope from `registerScopedService(LifecycleScope.X, …)`.

### Examples

Impl (`src/session/sessionMetadata/sessionMetadataService.ts`):

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

## Telemetry

Business events go through `ITelemetryService.track2` — never the low-level `track`, which exists only for appender plumbing and tests. Every event must be registered in `src/app/telemetry/events.ts` (`telemetryEventDefinitions`) before it is emitted: define a properties interface and document every property, then register it one of two ways — the compiler rejects unregistered event names and any property mismatch at the call site.

- Events whose every emission path goes through an Agent-scoped `ITelemetryService` view use `defineAgentTelemetryEvent<P>({ owner, comment, properties })`. `agent_id` is ambient Agent identity — declared once as `AgentTelemetryEventContext`, composed into the wire schema, and bound at runtime by the Agent-scoped `ITelemetryService` view that `agentLifecycle` seeds. Keep it out of the payload interface and out of call sites.
- All other events use `defineTelemetryEvent<P>({ owner, comment, properties })`. This includes Session/App-level events and events with any non-Agent emission path (e.g. `image_compress`, which the kap-server prompt routes emit through a session-scoped view). Per-event agent identity outside the Agent scope (e.g. `subagent_created`, `cron_scheduled`) stays as explicit `agent_id` business properties.

- **Naming**: event names and property keys are snake_case (`tool_call`, `duration_ms`). Durations, counts, and sizes carry a unit suffix (`_ms` / `_count` / `_bytes`). Use specific names (`error_type`, not `error`).
- **Privacy**: never register user content, prompts, or file paths as properties. `CloudAppender` redacts URLs, emails, tokens, and absolute paths from string values before events leave the process, but that is a safety net, not a license.
- **Stability**: registered event names and property keys are wire data consumed by dashboards — treat renames as breaking changes.
- The registry is the single source of truth; `test/app/telemetry/events.test.ts` enforces the naming conventions.

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
- [`docs/service-design.md`](docs/service-design.md) — Read **before designing a new Service**: first-principles rules for choosing a scope, splitting a domain Multi-Scope, picking a calling style (direct call vs event vs veto event vs hook), and directing dependencies — the design companion to `docs/di.md`.
- [`docs/flag.md`](docs/flag.md) — Read **before gating behavior behind a feature flag**: declaring a flag in its owning domain and registering it at import time via `registerFlagDefinition`, checking `IFlagService.enabled(id)`, wiring the `[experimental]` config section, or deciding whether a flag is App-scope vs. per-session.
- [`docs/errors.md`](docs/errors.md) — Read **before raising errors from a domain**: defining a co-located `XxxError`, registering a code in `ErrorCodes`/`ERROR_INFO`, translating external errors (provider/HTTP, fs, MCP) at the boundary, or (de)serializing errors across RPC/SDK with `toErrorPayload`/`fromErrorPayload`.
- [`docs/di-testing.md`](docs/di-testing.md) — Read **before writing or touching any DI/Scope test**: picking the right harness (`InstantiationService` vs `TestInstantiationService` vs `createScopedTestHost`), declaring deps with `@IService`, stubbing collaborators, and teardown via `DisposableStore`.
