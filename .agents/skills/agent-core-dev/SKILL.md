---
name: agent-core-dev
description: Use when developing in packages/agent-core-v2 (the DI × Scope agent engine) — adding or modifying a domain Service, choosing a LifecycleScope, wiring DI dependencies, splitting a domain across scopes, owning or migrating a config section, gating behavior behind an experimental flag, raising coded errors, working on the permission system, writing DI/Scope tests, porting business logic from agent-core (v1) to v2, triaging a main-branch commit against v2, or exposing a v2 domain over server-v2 while keeping the /api/v1 wire contract compatible with released clients. Self-contained guide organized by development stage (orient → design → implement → test → verify) plus align workflows for v1→v2 migration, main-branch commit triage, and server-v2 wire exposure; each file carries the rules, examples, and red lines for its step.
---

# agent-core-dev

> Develop `packages/agent-core-v2` by lifecycle stage. This skill is **self-contained**: every rule, recipe, and red line lives in the stage files below — it does not delegate to `packages/agent-core-v2/docs/`.

`agent-core-v2` is the new agent engine built on the **DI × Scope** architecture (a port of `packages/agent-core`). Everything resolves through the container: a service declares an **identity**, its **dependencies**, and a **lifetime**; the container decides construction, singleton-per-scope, ordering, and disposal. The stage files restate the rules in imperative form so you can work without reading the source docs.

## Lifecycle at a glance

```text
Orient → Design → Implement → Test → Verify
  │        │          │          │        │
  │        │          │          │        └─ lint:domain · typecheck · test · dep graph · red lines
  │        │          │          └─ test.md
  │        │          └─ implement.md (+ errors.md · flags.md · permission.md)
  │        └─ design.md
  └─ orient.md
```

Stages are ordered but not strictly linear: a test failure (stage 4) that reveals a wrong scope sends you back to design (stage 2); a `CyclicDependencyError` sends you to `design.md` §dependency-direction and `implement.md` §cycles.

## Workflows

End-to-end procedures that span the stages. Reach for these before reading the stage files individually.

- [Align (port `agent-core` → `agent-core-v2`)](align.md): split a v1 class into semantic units, fix each unit's domain / scope / Service / dependencies, then migrate the logic and tests. Use when the task is "move feature X from v1 to v2" or "port `IXxxService` to v2".
- [Commit align (triage a `main` commit against v2)](commit-align.md): given one `main` commit hash + a short note, find the v1 logic it changed, check whether v2 already has the corresponding implementation, bucket it (aligned / partial / missing / not-applicable), and recommend a minimal fix. Use in the `kimi-code-v2`-catching-up-to-`main` phase, for one commit at a time; escalate to [align.md](align.md) if the gap is a whole domain.
- [Server align (expose `agent-core-v2` over `server-v2`)](server-align.md): wire a v2 domain into `packages/kap-server` over `/api/v2` (native) and `/api/v1` (v1-compatible mirror), keep the wire schema byte-compatible with the established v1 contract by sharing the `@moonshot-ai/protocol` schema, and isolate v1-only behavior in a `<domain>Legacy` edge adapter instead of distorting the native v2 Service. Use when the task is "expose the new v2 Service on the server", "add a route to the `/api/v1` surface", or "keep server-v2 wire-compatible with released v1 clients".

## Stages

- [Stage 1 — Orient](orient.md): the DI black box (identity / dependencies / lifetime), the four `LifecycleScope` tiers and visibility, and the file-header comment convention. Read before touching business code.
- [Stage 2 — Design a service](design.md): pick a scope, split a domain across scopes, choose a calling style (direct call vs event vs hook), and direct dependencies. Decide *where things live and who knows whom* before coding.
  - Topic: [Domain boundaries vs Scope](domain-boundaries.md) — keep `session` / `agent` / `turn` from becoming god objects; data-ownership test and their split conclusions.
  - Topic: [Persistence layering](persistence.md) — the three-layer `Store → Storage → backend` model, naming Stores by access pattern, and which layer business code should depend on.
  - Topic: [Edge exposure — `resource:action` + WS events](edge-exposure.md) — which Services are exposed over `/api/v2` (per-scope action map) and which events stream over WS; what to wrap in a facade.
- [Stage 3 — Implement](implement.md): the standard Service recipe and the DI building blocks — interface + identity, constructor injection, scoped registration, `Disposable`, eager vs delayed, `invokeFunction`, `createInstance`, child scopes, and the cycle-refactor playbook.
  - Topic: [Service authoring](service-authoring.md) — file layout, naming, contract vs impl contents, interface style, constructor/field conventions, events, multi-Service domains, comment rules.
  - Topic: [Config](config.md) — the section-registry model, App vs Session split, owning a config section, the TOML format, and the env overlay.
  - Topic: [Errors](errors.md) — co-located `XxxError`, the central code registry, wire serialization, boundary translation.
  - Topic: [Flags](flags.md) — `registerFlagDefinition`, `IFlagService.enabled(id)`, the `[experimental]` config section, resolution precedence.
  - Topic: [Permission](permission.md) — risk-only chain-of-responsibility kernel, harness constraints and product reviews as domain `onBeforeExecuteTool` veto listeners (`veto` / `allow` / `pass` / cold `waitUntil` factories), shared `toolApproval` round-trip, policy registry + composer, `modes`/`agentTypes` metadata, `resolveExecution`/`accesses`.
  - Topic: [Telemetry](telemetry.md) — emitting events via `ITelemetryService`, context propagation, and appender destinations (`ConsoleAppender` / `CloudAppender`).
- [Stage 4 — Test](test.md): resolve the system under test by interface, pick `TestInstantiationService` vs `createScopedTestHost`, shared stubs, service groups, teardown.
- [Stage 5 — Verify & submit](verify.md): `lint:domain`, `typecheck`, `test`, and the pre-submit checklist.

## How to use this skill

Jump to the stage you are in and read that one file; each is self-contained and ends with its own red lines. Skim the global red lines below before submitting — they catch most mistakes across every stage. The repo's source of truth remains the code in `packages/agent-core-v2/src/`; this skill codifies the same rules so you do not have to re-derive them.

## Global red lines

Invariants that hold across every stage. Each is expanded in the stage file noted.

1. No `new` on a class whose constructor carries `@IService` deps — inject with `@IX` or `accessor.get(IX)`. (implement.md)
2. `@IX` decorates constructor parameters only; parameter order depends on construction (static-first for `createInstance`, `@IX`-first for scoped services). (service-authoring.md)
3. Both interface and impl carry `_serviceBrand`; the `createDecorator` name is globally unique. (implement.md)
4. Parent scope never depends on child scope — short-lived may inject long-lived, never the reverse. (orient.md)
5. No cyclic dependencies — refactor (extract a third Service / use an event / re-scope); do not break the cycle with `Delayed`. (design.md, implement.md)
6. `ServicesAccessor` is valid only during `invokeFunction` — never stash it for async use. (implement.md)
7. Scope follows state identity — no `Map<sessionId, …>` at `App` to fake per-session state. (design.md)
8. Foundational layers never know upstream ones; business code never depends on the edge layer (`gateway`/`rpc`). (design.md)
9. Throw coded errors; register codes centrally; branch on `code` across the wire, never `instanceof`. (errors.md)
10. Gate unreleased behavior behind a flag contributed via `registerFlagDefinition` and resolved through `IFlagService.enabled(id)`; no ad-hoc env toggles. (flags.md)
11. Tests resolve the SUT by interface; shared stubs live under `test/`, never `src/`. (test.md)
12. Config is the preference registry: only preferences that are persistable, schema'd, and user/operator-facing go in `IConfigService`. Domain-specific config (including env-only operational toggles) goes through `registerSection` + `envOverlay`. Facts → `IBootstrapService` (kept domain-agnostic — never add cron/flags/model state); session state → Session scope; constants → code. Business domains never call `IBootstrapService.getEnv()` directly. (config.md)
