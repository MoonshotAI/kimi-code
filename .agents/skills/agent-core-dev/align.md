# Subskill — Align (port `agent-core` → `agent-core-v2`)

Port business logic from `packages/agent-core` (v1) into `packages/agent-core-v2` (v2) by **splitting semantics, then fixing the domain, scope, Service, and dependency relationships**, and finally migrating the logic and tests.

Use this when the task is "move feature X from v1 to v2", "port `IXxxService` to v2", or "align a v1 domain with the v2 architecture". It complements the stage files: orient / design / implement / test explain the *target* architecture; this file explains how to get there *from v1*.

## The one-paragraph mental model

v1 is a **VSCode-style singleton container**: services self-register with `registerSingleton`, resolve as singleton-per-container, and have no explicit lifetime tier — so a single `ISessionService` / `IToolService` tends to accumulate global, per-session, and per-agent state in one class. v2 is a **DI × Scope tree**: every service binds to one of `App` / `Session` / `Agent`, and a domain with state at several lifetimes is split into several Services. Porting is therefore **not** a file copy — it is "find each lifetime of state hiding in the v1 class, give each its own v2 Service at the right scope, then re-wire the dependencies".

## v1 → v2 at a glance

| Concern | v1 (`agent-core`) | v2 (`agent-core-v2`) |
|---|---|---|
| Registration | `registerSingleton(IX, X, InstantiationType.Delayed)` | `registerScopedService(LifecycleScope.X, IX, X, InstantiationType.Delayed, 'domain')` |
| DI import | `from '../../di'` | `from '#/_base/di/scope'` / `'#/_base/di/instantiation'` / `'#/_base/di/extensions'` / `'#/_base/di/lifecycle'` |
| Lifetime | implicit singleton-per-container | explicit `LifecycleScope` (App/Session/Agent) — see orient.md |
| Domain granularity | coarse (`session`, `tool`, `loop`) | fine, split by scope + responsibility |
| Test import | `from '@moonshot-ai/agent-core/di/test'` | `from '#/_base/di/test'` |
| Resolve SUT in tests | `ix.createInstance(Impl)` (common) | `ix.get(IX)` by interface — see test.md |
| Scope tests | none | `createScopedTestHost` — see test.md |
| Errors | `from '../../errors'` (central `KimiError`, `ErrorCodes`) | `from '#/_base/errors'` + domain co-located `XxxError` — see errors.md |
| Flags | `flags/` (process-global `FlagResolver`) | `flag/` (App-scope `IFlagService`) — see flags.md |
| Permission | `agent/permission/` (hardcoded chain) | `permission*` (registry + composer) — see permission.md |

## The align workflow

```text
Read v1 → Semantic split → Map domain → Assign scope → Shape Services
        → Direct dependencies → Port logic → Port tests → Verify
```

Each step below states the goal and the concrete action, then points to the stage file that goes deeper. Do them in order; a later step often sends you back to an earlier one (a scope that does not fit means the semantic split was wrong).

### 1. Read v1

**Goal:** build an accurate inventory of what the v1 code actually owns. Read the v1 *source*, not v1 docs.

Actions:

- Locate the v1 entry: contract (`<domain>/<domain>.ts`) + impl (`<domain>/<domain>Service.ts`), plus any helpers under the same folder.
- Inventory three things from the impl:
  - **State** — every field / `Map` / cache the class holds. For each, note its *identity* (global? keyed by `sessionId`? by `agentId`?).
  - **Behavior** — every public method; group them by which state they touch.
  - **Dependencies** — every `@IFoo` constructor injection and every cross-domain relative import (`from '../<other>/...'`).
- Note the v1 registration line (`registerSingleton(...)`) and any `services.set(IX, ...)` overrides at bootstrap (these reveal runtime static args or prebuilt instances the port must preserve).

Do not start splitting yet — an accurate inventory prevents the common mistake of porting the class shape instead of the semantics.

### 2. Semantic split

**Goal:** break one v1 class into independent semantic units, each owning state at exactly one lifetime. This is the heart of the port.

Method — for each piece of state from the inventory, ask:

1. **What is it keyed by?** nothing → a global unit; `sessionId` → a per-session unit; `agentId` → a per-agent unit.
2. **When should it die?** with the process / the session / the agent. State that must outlive its neighbors is a different unit.
3. **Which methods touch only this state?** they travel with the unit.

Worked example — v1 `ISessionService` (one class, ~600 lines) holds:

- a global index of all sessions → **global** unit → v2 `sessionStore` (`ISessionStore`, App);
- this session's metadata → **per-session** unit → v2 `sessionMetaStore` (`ISessionMetaStore`, Session);
- this session's activity / status → **per-session** unit → v2 `sessionActivity`;
- this session's context projection → **per-session** unit → v2 `sessionContext`;
- child-agent lifecycle driven by a session → **per-session** unit → v2 `agentLifecycle`; create/close/archive/fork of the session itself → **global** unit → v2 `sessionLifecycle` (App).

A v1 class that maps cleanly to one v1 decorator often becomes **three to five** v2 Services. That is expected and correct — do not try to keep the v1 class shape.

Red lines:

- If two pieces of state have different identities, they belong in different units — do not keep them together "because v1 did".
- Do not split by method count or file aesthetics; split by state identity (design.md §3).
- If a unit has no mutable state (pure behavior), defer its scope decision to step 4 (it is pulled down by its shortest-lived dependency).

### 3. Map to v2 domain

**Goal:** assign each semantic unit to a v2 domain — an existing one if it fits, a new one only if none does.

Actions:

- Search v2 `src/` for an existing domain that owns the same responsibility. Prefer joining an existing domain over creating a new one.
- If creating a domain, name it after the responsibility (camelCase folder, e.g. `sessionActivity`), not after the v1 file.
- Keep a domain's public surface to one contract file (`<domain>.ts`) plus its impl(s).

Reference mapping (a **starting point**, not gospel — verify against the current v2 `src/`, which is the source of truth):

| v1 location | v2 domain(s) |
|---|---|
| `services/session/`, `session/` | `session`, `sessionStore`, `sessionMetaStore`, `sessionActivity`, `sessionContext`, `agentLifecycle` |
| `services/tool/`, `tools/`, `agent/tool/` | `toolRegistry`, `toolStore`, `toolExecutor`, `tooldedup`, `userTool` |
| `loop/`, `agent/` (turn loop) | `loop`, `llmRequester`, `llmRequestLog`, `turn` |
| `agent/context/`, `agent/compaction/` | `contextMemory`, `contextProjector`, `contextSize`, `fullCompaction`, `dynamicInjector` |
| `agent/permission/` | `permission`, `permissionMode`, `permissionPolicy`, `permissionRules`, `approval`, `externalHooks` |
| `agent/goal/`, `agent/plan/`, `agent/swarm/`, `agent/cron/`, `agent/background/` | `goal`, `plan`, `swarm`, `cron`, `background`, `subagentHost` |
| `services/config/`, `agent/config/` | `config` |
| `services/event/`, `base/common/event` | `event`, `eventBus` |
| `services/logger/`, `logging/` | `log` |
| `services/fileStore/` | `filestore`, `blobStore` |
| `services/fs/`, `services/workspace/` | `fs`, `workspace` |
| `services/auth/`, `services/oauth/` | `auth` |
| `services/environment/` | `environment` |
| `services/terminal/` | `terminal` |
| `services/question/`, `services/approval/` | `question`, `approval` |
| `services/prompt/`, `agent/injection/` | `prompt`, `dynamicInjector` |
| `services/mcp/`, `mcp/` | `mcp` |
| `plugin/`, `profile/`, `skill/` | `plugin`, `profile`, `skill` |
| `rpc/`, `services/coreProcess/` | `rpc`, `gateway` |
| `di/` | `_base/di` |
| `errors/`, `errors.ts` | `_base/errors` + co-located domain errors |
| `flags/` | `flag` |
| `telemetry.ts` | `telemetry` |
| `agent/records/` | (records split) — verify in v2 `src/` |

When the table says "verify", or when v1 and v2 have diverged, **read the v2 `src/` tree and decide from the code** — do not invent a mapping.

### 4. Assign scope

For each semantic unit, fix its `LifecycleScope` from the identity you found in step 2. Follow design.md §2 verbatim:

- global → `App`; per `sessionId` → `Session`; per `agentId` → `Agent`.
- Stateless unit → default to `App`, pulled down only by a shorter-lived dependency.
- Self-check: "when this scope is disposed, should this state disappear with it?"

This is the decision v1 never had to make — get it right before writing any v2 code, because the scope is fixed at registration and changing it later ripples through every consumer.

### 5. Shape Services

Decide the Service shape per unit, following design.md §3:

- A unit that owns **one instance's** state → a single per-instance Service (`ISessionXxx` / `IAgentXxx`).
- A unit that owns a **global view plus per-instance** state → split into an `App` registry/factory (`XxxStore` / `XxxRegistry` / `XxxCatalog`) **and** a per-instance Service. The `App` half creates or locates the per-instance half.
- Do not pre-split a unit that has state at only one lifetime.

Most consumers inject the per-instance Service; inject the `App` factory only for genuine cross-instance management.

### 6. Direct dependencies

Re-wire the dependencies you inventoried in step 1, now across the new v2 Services. Follow design.md §4–§5:

- **Calling style** — need a result / I orchestrate → direct call (`@IX` injection); stating a fact → event; ordered participation that may veto → hook.
- **Scope direction** — a Service may inject only its own scope or an ancestor. If an `App` Service needs something from a `Session` Service, the dependency is backwards: re-scope or invert into an event.
- **Domain direction** — foundational layers must not know upstream ones. A cycle means a v1 relative import is now pointing the wrong way; extract a third Service or invert the notification into an event.
- **Durable facts** — state changes that must be recorded / replayed / projected across agents go on the wire (`wireRecord`), not a direct call alone.

Run `lint:domain` (verify.md) as soon as the dependencies compile — it catches direction violations early.

### 7. Port the business logic

Move the behavior into the shaped v2 Services, applying the mechanical conversions below. Follow implement.md for the recipe.

**Registration:**

```ts
// v1
import { InstantiationType, registerSingleton } from '../../di';
registerSingleton(IXxxService, XxxService, InstantiationType.Delayed);

// v2
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
registerScopedService(LifecycleScope.Session, IXxxService, XxxService, InstantiationType.Delayed, 'xxx');
```

**Imports:**

```ts
// v1
import { createDecorator, Disposable, IInstantiationService } from '../../di';
import { KimiError, ErrorCodes } from '../../errors';

// v2
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { KimiError, type ErrorCode } from '#/_base/errors';
```

**Constructor injection** — unchanged in shape (`@IX` on constructor params, service params after static params). Verify each dependency is resolvable from the new scope (step 6).

**Errors** — move any shared error into a co-located `XxxError extends KimiError` with a registered `code` (errors.md). Do not keep throwing v1's central error codes from a v2 domain.

**Flags** — replace any `FlagResolver` / env check with `IFlagService.enabled(id)`; contribute new flags from the owning domain's `flag.ts` via `registerFlagDefinition` (flags.md).

**Events** — v1's `Emitter` / `Event` from `base/common/event` maps to v2's `event` / `eventBus` domains. Read existing v2 usage in neighboring domains and match it; do not import v1's `Emitter`.

**Runtime static args / prebuilt instances** — if v1 bootstrap did `services.set(IX, new SyncDescriptor(C, [bag]))` or set a prebuilt instance, preserve that behavior at the v2 composition root (the scope that owns the Service). Do not silently drop it.

Red lines:

- Do not copy a v1 file and "fix imports". Re-split first (steps 2–6); a straight copy carries v1's implicit-singleton assumptions into v2 and creates the `Map<sessionId, …>`-at-`App` anti-pattern.
- Do not leave v1 relative imports (`from '../x/...'`) in v2 — use the `#/...` alias and respect the domain layers.
- Do not preserve a v1 behavior just because it exists; if the split reveals it was a workaround for the missing scope tree, drop it.

### 8. Port the tests

Convert v1 tests to the v2 harness, following test.md:

```ts
// v1
import { TestInstantiationService } from '@moonshot-ai/agent-core/di/test';
const svc = ix.createInstance(XxxService, 'static-arg');

// v2
import { createServices } from '#/_base/di/test';
// in additionalServices:
reg.define(IXxxService, XxxService);
// in the test body:
const svc = ix.get(IXxxService);
```

- Resolve the SUT by interface (`ix.get(IX)`), never `new` a `@IService`-carrying impl, and prefer `ix.get(IX)` over `ix.createInstance(Impl)`.
- Move shared stubs into `test/<domain>/stubs.ts`; import by relative path, never `#/...`.
- If the port introduced scope-layer behavior, add a `createScopedTestHost` test that asserts resolution from the correct scope (with `_clearScopedRegistryForTests()` + explicit re-registration in `beforeEach`).
- Keep v1's behavioral assertions where they still describe observable behavior; delete assertions that only checked v1's internal class shape.

## Migration checklist

Before submitting a port:

- [ ] Every piece of v1 state landed in a v2 Service whose scope matches its identity (no `Map<sessionId, …>` at `App`).
- [ ] Each v1 dependency now points in the right scope and domain direction; `lint:domain` passes.
- [ ] Registrations use `registerScopedService` with an explicit scope and domain name; no `registerSingleton` remains.
- [ ] Imports use the `#/...` alias; no v1 relative (`../../di`, `../../errors`) imports remain.
- [ ] Errors are co-located coded errors; flags go through `IFlagService`.
- [ ] Tests resolve the SUT by interface; scope behavior is asserted via `createScopedTestHost`; teardown goes through one `DisposableStore`.
- [ ] v1 bootstrap overrides (`services.set(...)`) are preserved at the v2 composition root.

## Red lines (this subskill)

- Porting is semantic splitting, not file copying — never preserve a v1 class shape in v2.
- Decide scope from state identity before writing v2 code; the scope is fixed at registration.
- Verify the domain mapping against current v2 `src/`; the table here is a starting point, not authority.
- One Service owns state at exactly one lifetime; split global-view + per-instance into registry + per-instance.
- A dependency cycle introduced by the port means a v1 import is now backwards — refactor, do not route around it with `Delayed`.
