# The v2 architecture, explained for v1 readers

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md) ("the main document"); Chinese mirror: [`architecture.zh-CN.md`](architecture.zh-CN.md).

This document does not tell you how to migrate — the main document does that. It explains *why* v2 looks the way it does, in terms a v1 reader already knows: how v1's DI and services layer worked, what v2 added on top, how scopes and units live and die, what the Feature seam is, and which historical decisions produced this shape.

## 1. How v1's DI and services layer worked

### 1.1 The DI container (`packages/agent-core/src/di/`)

v1's DI is a zero-dependency port of VSCode's `vs/platform/instantiation`, about 600 LoC, with its own authoritative documentation at `packages/agent-core/src/di/README.md` (319 lines, including a full bootstrap example). The pieces:

- `createDecorator<T>(name)` (`di/instantiation.ts:65`) mints a branded callable `ServiceIdentifier<T>` (a same-named singleton); it doubles as a constructor-parameter decorator, and the interface must declare `readonly _serviceBrand: undefined`.
- `SyncDescriptor<T>` (`di/descriptors.ts:12`) wraps ctor + static args + a `supportsDelayedInstantiation` flag.
- `ServiceCollection` (`di/serviceCollection.ts:11`) is the per-container id → (descriptor | instance) map.
- `InstantiationService` (`di/instantiationService.ts:108`) is the runtime container: `invokeFunction(accessor)` (:143), `createInstance` (:187), `createChild(services)` (:200), idempotent `dispose()` (:213).
- `registerSingleton` / `getSingletonServiceDescriptors` (`di/extensions.ts:46` / `:87`): a module-level global registry (array append; duplicate ids do not throw, the later registration wins). Bootstrap seeds the root container from `getSingletonServiceDescriptors()`.
- `InstantiationType` (`di/extensions.ts:23`): `Eager = 0` / `Delayed = 1`. Delayed means the container returns a `Proxy`; the real ctor runs only on the first non-event property access, and early `onDid*` subscriptions are parked and rebound after materialization.
- Cycle detection has two mechanisms (`di/graph.ts:11` / `di/errors.ts:30`): a pre-construction Graph walk (leaves-first) plus the root container's `_inProgress` construction stack as a fallback for ctor-body re-entrant edges.
- `Disposable` / `IDisposable` (`di/lifecycle.ts`): the disposal contract; `dispose()` is idempotent, child containers go first, instances of this container go in reverse construction order (LIFO), and lazily-materialized Proxies get a second pass via `_servicesToMaybeDispose`.
- `TestInstantiationService` (`di/testInstantiationService.ts:25`) is exported only via the subpath `@moonshot-ai/agent-core/di/test`, providing `.get` / `.set` / `.stub`.

The injection idiom: constructor parameters decorated with `@IFoo` are auto-injected (static args lead, service args follow; `GetLeadingNonServiceArgs` derives the prefix); `@IInstantiationService` injects the owning container itself (a child container resolves to the child).

### 1.2 The services layer (`packages/agent-core/src/services/`)

The normative spec is `packages/agent-core/src/services/AGENTS.md` (190 lines). The facts:

- **Position**: agent-core's "upper facade" layer — it may depend downward on the runtime (`rpc/`, `session/`, `agent/`, `di/`); the runtime must never import `services/` back (AGENTS.md:8-13). Merged in from a former separate services package.
- **Naming**: a uniform `Service` suffix (no Bus/Broker/Bridge/Registry/Manager); the decorator string is the interface name minus `I` in lowerCamelCase, and shows up in `CyclicDependencyError.path` and "No service registered" errors (AGENTS.md:20-27).
- **File convention**: one camelCase directory per domain; a contract file `<domain>.ts` (interface + decorator + sentinel errors) and an implementation file `<domain>Service.ts` that self-registers at the bottom with `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)` (AGENTS.md:40-58, 125-141).
- **Four facade roles** (expressed via docstrings and interface shapes, AGENTS.md:33-38): business facade (mostly `Promise<T>`, e.g. `IPromptService.submit`) / one-shot reverse RPC broker (`request`+`resolve`, e.g. `IApprovalService`) / pub-sub bus (`publish`+`onDidXxx`, e.g. `IEventService`) / cross-process RPC adapter (`rpc`+`ready()`, e.g. `ICoreProcessService`).
- **Domain inventory**: 22 domain directories (approval, auth, authSummary, config, coreProcess, environment, event, fileStore, fs, logger, mcp, message, modelCatalog, oauth, prompt, question, session, skill, task, terminal, tool, workspace).
- **Bootstrap consumption**: the server seeds from `getSingletonServiceDescriptors()`; only when runtime parameters or external closures are needed does it override with `services.set(I, new SyncDescriptor(C, [args], false))`.
- **The v1 engine shape**: the `KimiCore` / `Session` (`src/session/index.ts:230`) / `Agent` (`src/agent/index.ts:115`) class hierarchy plus this DI service layer; `CoreProcessService` (`services/coreProcess/coreProcess.ts:57`) is the cross-process adapter holding the `rpc: CoreRPC` mega-proxy (internally a `createRPC<CoreAPI, SDKAPI>()` pair + `new KimiCore(coreRpc)`).

The mental model to carry forward: v1 has exactly **one** container tree (root + children created ad hoc), a **static, module-level** singleton registry seeded once at bootstrap, and a services layer whose lifetime equals the process. Everything v2 adds exists to give registrations a *scope* and a *lifecycle*.

## 2. What v2 `_base/di/` adds on top

v1's `di/` was ported directly (same-named files: instantiation / instantiationService / descriptors / serviceCollection / extensions / graph / lifecycle / errors / test*). v2 adds 6+1 files. The container body `InstantiationService` (`_base/di/instantiationService.ts:121`) builds a `CascadeTree` (root container) + `CascadeEngine` at construction (:177-219); child containers share the parent's tree and `CollectionStore` (:177-180).

| File | One-line responsibility | Key types |
|---|---|---|
| `scope.ts` | declarative scope topology + per-scope static service registry + the `Scope` tree (parent-child derivation, topology validation, Ledger cascade disposal) | `ScopeKind` (:13), `setScopeTopology` (:17, redeclaring a different topology throws `BugIndicatingError`), `registerScopedService`/`overrideScopedService` (:47/:70, duplicate registration throws), `ScopeActivation` (from instantiation.ts:131, `OnScopeCreated=0`/`OnDemand=1`), `createScopedChildHandle` (:153), `Scope` (:181, `createApp`/`createChild`/`dispose`), `IScopeHandle` (:111) |
| `fiber.ts` | the Fiber unit protocol: services/units are provided as recipes with five capabilities `provide/effect/on/get/ref`; handles are awaitable, `update(config)`-able, disposable | `Fiber` (:67), `FiberHandle` (:89, thenable, settles on activation), `FiberState` (:20, Pending/Activating/Active/Unloading/Failed), `ServiceRecipe` (class/function/object forms, :41-60), `RecipeStatics` (`name`/`inject`/`Config`/`meta`, :34), `ScopeUnits(kind)` (:705, one `CollectionToken<ServiceRecipe>` per scope), `FiberHost` (:153, the container-side host interface) |
| `service.ts` | the `Service` abstract base class: extending it grants Fiber capabilities; construction-time calls are buffered (`PendingFiberHandle`) and replayed by `bindServiceUnit` once construction finishes; **construction time is write-only** (`get`/`ref` throw `FiberProtocolError`); a manually `new`ed instance has no capabilities | `Service` (:24, extends `Disposable` implements `Fiber, UnitInternals`), the `SERVICE_MARK` prototype marker (fiber.ts:132, service.ts:138) |
| `collection.ts` | multi-provider contribution points: `collection(name)` mints a token, any Fiber can `provide(token, value)`; a token can decorate a constructor parameter to inject a `CollectionView`; visibility = the container ancestor/descendant chain (`_isRelated`); `definition(name)` is the single-provider-validated specialization | `CollectionToken` (:5), `collection()` (:43)/`definition()` (:77), `CollectionStore` (:123, unique per root container), `CollectionView` (:106, `items`/`records`/`onDidChange`), `DefinitionView` (:30, `current`/`onDidChangeDefinition`) |
| `cascadeEngine.ts` | the cross-scope reactive transaction engine: provide/unprovide/update changes are queued and executed in batches, the affected set is computed from the dependency graph, then teardown in reverse-topological order → apply changes → rebuild at points, with full history | `CascadeEngine` (:183), `CascadeTree` (:114, tree-wide queue/in-flight sets), `CascadeChange` (:19), `UnitState` (:13), `CascadeHistoryEntry` (:29, ring capacity 200), the `onWillCascade` abort hook (5s default wait, :110/527-558), `resolveWhenAvailable` (30s timeout, :343), `suspendActivation/resumeActivation` (:307/311, suspended during scope assembly, point-rechecked on resume) |
| `dependencyGraph.ts` | a runtime instance-level dependency graph (not v1's static ctor-metadata graph): scoped-token nodes + instance/collection edge kinds; provides affected sets, topo/reverse-topo orders, cycle detection | `DependencyGraph` (:59), `ScopedToken` (:3), `DependencyEdgeKind = 'instance' \| 'collection'` (:8); **note**: `affectedSet` (:112) propagates only along `instance` edges |
| `scopeUnits.ts` | `watchScopeUnits(container, kind)` (:15): attached at scope creation, materializes the recipes recorded in the `ScopeUnits(kind)` collection into real units (class → `constructService`, function/object → wrapped in a `FiberRuntime` facade), and reclaims them when their provider dies (reconcile loop) | no exported types; called from the three creation paths in `scope.ts` (scope.ts:165, 220, 258) |

New container API surface (`IInstantiationService`, instantiation.ts:171-200): `cascade`, `provide(id, x, {activation, config})`, `provideAll(entries)`, `unprovide(id)`, `disposeAsync()`; a new dependency kind `DependencyKind = 'instance' | 'collection' | 'ref'` (instantiation.ts:7), and `@ref(id)` injecting `LiveRef<T>` (:136-150, a weak observation handle).

Against v1's picture, the conceptual jump is: registration is no longer a module-level array but a *scoped, lifecycle-carrying unit* — it can be activated on scope creation or on demand, updated with new config (with dependent units rebuilt around it), disposed individually, and discovered through contribution collections.

## 3. LifecycleScope tiers and the unit lifecycle

### 3.1 Fact check first: this baseline has **three** DI scope tiers, not four

- `packages/agent-core-v2/src/app/scopes.ts:3-13`: the `LifecycleScope` enum has only three members — `App` / `Session` / `Agent` — and `SCOPE_TOPOLOGY` declares those three via `setScopeTopology`.
- There is no `LifecycleScope.Workspace` anywhere in the repo; `Scope.createChild` enforces that the child kind sits after the parent kind in the topology (scope.ts:240-248). There are exactly two production derivation points: `workspace/sessionLifecycle/sessionLifecycleService.ts:264` (`createScopedChildHandle(..., LifecycleScope.Session, sessionId, ...)`) and `session/agentLifecycle/agentLifecycleService.ts:156` (`createScopedChildHandle(..., LifecycleScope.Agent, agentId, ...)`).
- Workspace-level capability is not a DI scope: `Program` (`src/program/program.ts:113`) is a per-workspace generation object (holding state/dirs/fs/watch/git/instructions/mcp/skills/agentProfiles), and `IWorkspaceInstanceManager` is registered at **App** scope (`workspace/workspaceInstance/workspaceInstanceManagerService.ts:312`).
- **Note (resolved 2026-09-19)**: an earlier revision of the main document `packages/agent-core-v2/docs/migration-from-v1.md:21` said "four LifecycleScope tiers (App / Workspace / Session / Agent, `src/app/scopes.ts`)", which does not match the code at this baseline (three tiers; Workspace is a Program/generation concept). The main document has since been corrected to three tiers; this document follows the code fact.
- Historical context: the agent-domain-model migration's target end-state was **two** tiers (App→Session, with the Agent DI scope deleted), but the remaining agent domains work was archived unmerged on 2026-09-07 (see §5), and `LifecycleScope.Agent` still has 54 use sites at this baseline (e.g. `agent/loop/loopService.ts:1590`, `wire/wireService.ts:377`, `state/eventDispatcherService.ts:857`).
- There is also one bare, non-LifecycleScope `createChild`: `runtime/runtimeUnitHost.ts:271` (an isolated child container for runtime-unit transactions, execution-runtime infrastructure, not part of the scope topology).

### 3.2 The scope derivation and disposal chain

- **App**: `bootstrap(input, extraSeeds?)` (`app/bootstrap/bootstrap.ts:138`) → `createAppScope` (scope.ts:298 → `Scope.createApp`:213) → `new InstantiationService(collection, /* strict */ true)`; seeds include `IBootstrapOptions`, storage, and skill discovery (bootstrap.ts:125-161).
- **Assembly sequence** (isomorphic across the three creation paths, scope.ts:213-230/238-273): `cascade.suspendActivation()` → `watchScopeUnits` → `configureContainer?` → `provideScopeServices` (entries for this kind from `_scopedRegistry` are poured in via `provideAll`, activation policy mapping `OnScopeCreated→'eager'` / `OnDemand→'ondemand'`) → `resumeActivation()` (point recheck; eager units materialize in topological order, cascadeEngine.ts:324-341/666-707).
- **Session derivation**: `sessionLifecycleService.ts:241-299`; seeds include `ISessionContext`, telemetry binding, agentProfileCatalog, skill catalog, instructions, `ISessionMcpHandle`, workspace info, ephemeral MCP servers; inside `configureContainer` it fires `_onWillCreateSession`, whose listeners may `contributeSeed` / `onSessionDispose` (:287-296).
- **Agent derivation**: `agentLifecycleService.ts:130-208`; seeds include `IAgentScopeContext` (`agentId+generation+forkedFrom`), telemetry binding, `IAgentRuntimeBindingSeed`; then `IWireService.seal()`, roster registration, and firing `onDidCreate` / `onDidCreateScope`.
- **Disposal**: `Scope.dispose()` (scope.ts:279) → its own `Ledger.teardown('scope-close')` → registered items include `instantiation.dispose` and child-scope reclamation (scope.ts:196-202, 269-271); `InstantiationService.disposeCore` (:666-695): child containers `disposeAsync` recursively → this container's `Ledger.teardown` → `_services.dispose()` → `cascade.dispose()` → collection views destroyed; `Ledger` (`_base/lifecycle/ledger.ts:37`) is a labeled, ordered resource book (`register`:63 / `effect`:73 / `teardown`:123 / `clear`:140 / `release` single-item).

### 3.3 The Service/Fiber unit lifecycle

- State machine: `FiberState` (fiber.ts:20) / `UnitState` (cascadeEngine.ts:13): `Pending → Activating → Active → (Unloading)`, with a `Failed` side track.
- Activation: eager units materialize in topological order during scope assembly / cascade-transaction point rechecks (`_activate`, cascadeEngine.ts:709); ondemand units materialize on the first `accessor.get`, with the cascade recording state via `observedMaterialization` (:374).
- Construction protocol: a class recipe is constructed via `constructService` while a `ConstructionFrame` is pushed (fiber.ts:111-130); the `Service` base class buffers construction-time `provide/effect/on` calls into `__unitBuffer`, replayed and bound to a `FiberRuntime` by `bindServiceUnit` (fiber.ts:199) after construction; from then on all capabilities are booked to the unit's own `Ledger` (`unitBook`) and reclaimed wholesale at unit teardown.
- Update and teardown: `FiberHandle.update(config)` triggers `updateToken` → a cascade `update` transaction: the affected set is torn down in reverse-topological order `_teardownForCascade` (back to Pending) → new config applied → point rebuild; `handle.dispose()` / scope close triggers `core.dispose()` via Ledger entries (fiber.ts:401-420). Config is validated against the standard schema (the `Config` static, `~standard.validate` must be synchronous, fiber.ts:229-247).
- Handle semantics: `FiberHandle` is thenable — `await handle` yields the settled view after activation (fiber.ts:603-644); failed units reject on settle.

## 4. The Feature seam: registration and assembly

Four mechanism files (`src/features/`) plus a management surface (`src/app/feature/`):

1. **`features/feature.ts:38`** — `abstract class Feature extends Service`. The `contribute*` family is all sugar over dropping records into collection tokens:
   - `contribute(token, value)` (:39) → any `CollectionToken`;
   - `contributeSessionModel` / `contributeAgentModel` (:43/:47) → `SessionModelContribution` / `AgentModelContribution` (`#/state/agentModel`);
   - `contributeConfig(domain, schema)` (:53) → `ConfigSectionContribution`;
   - `contributeService(scope, id, ctor, opts)` (:65) → first a `FeatureServiceContribution` record (discoverability metadata), then an object recipe into `ScopeUnits(scope)` (`apply(fiber) { fiber.provide(id, ctor, opts) }`) — the service materializes/reclaims with the target scope's creation/record survival (the scopeUnits.ts mechanism); `contributeAgentService` = the Agent-scope specialization (:80);
   - `contributeTool(id, ctor, options)` (:88) → an Agent-scope OnDemand service + an `AgentToolContribution` record;
   - `contributeCommand` / `contributeProfiles` (:99/:103) → `CommandContribution` / `AgentProfileContribution`.
2. **`features/featureRegistry.ts:5`** — `registerFeature(recipe)`: a module-level global recipe table (`_featureRecipes`), read out via `getFeatureRecipes()`. At this baseline **18 Features** self-register: btw, contextBudget, cron, dateChange, debugEvents, externalHooks, fileHistory, goal, interaction, plan, reminder, sessionInit, skill, swarm, todo, tokenCounting, tower, usage (at the bottom of each `features/<name>/<name>Feature.ts` file).
3. **`features/featureAssembly.ts:7`** — the `IFeatureAssemblyService` token (an empty interface, an assembly trigger only). **`features/featureAssemblyService.ts:9`** — `FeatureAssemblyService extends Service`, registered at **App scope + `ScopeActivation.OnScopeCreated`** (:20-26); its constructor injects `@IFeatureManager` and `featureManager.provideUnit(recipe)`s every recipe from `getFeatureRecipes()` (:12-17). In other words: **App scope creation → eager activation → all Features instantiated and their construction-time contributes executed**.
4. **`app/feature/featureManager.ts:19`** — `IFeatureManager`: `provideUnit(recipe|id+ctor, opts)` / `unprovideUnit(name)` / `updateUnit(name, config)` / `units()` / `contributedServices()` / `onDidChangeUnits`. **`featureManagerService.ts:23`** — the implementation (App scope, OnScopeCreated, :107-113); replacing a same-named unit disposes the old handle first (:57-59); answers discoverability queries through a `CollectionView<ContributedFeatureService>` injected via `@FeatureServiceContribution` (:34). **`featureServiceContribution.ts:10`** — `collection('feature-service')`, validated unique per `(scope,id)` (duplicates throw).
5. **Loading** (the composition root): side-effect imports of each `*Feature` module at the top of `src/index.ts` (e.g. `import '#/features/todo/todoFeature'`, index.ts:747; 18 of them) + `import '#/features/featureAssemblyService'` (index.ts:273) — importing the package root completes recipe registration and assembly-service registration, isomorphic to v1's barrel side-effect registration.

Feature unload semantics: `unprovideUnit` disposes the Feature handle → the Feature's own Ledger reclaims all its provides (ScopeUnits records, collection records) → the target scope's `watchScopeUnits` reconcile reclaims materialized services; the `FeatureServiceContribution` metadata disappears from the view when its provider dies (semantics fixed in the v2 scan).

## 5. Migration history and key decisions

Sources: the background/decision sections of the corresponding work-item decision records (v2 agent-rpc removal, kap edge adapters, v2 scan, agent-session-domain, agent-domain-model migration, remaining agent domains, remove agent-core v1) plus the main document. These decision records are not part of this repository; the timeline is checkable, and the decisions are quoted below with their original basis.

### 5.1 Timeline

| Date | Event | Evidence |
|---|---|---|
| 2026-08-12 | **v2 agent-rpc removal** (PR #2871 merged): deleted the v2 in-engine `src/agent/rpc/` 5-file aggregation layer; the non-trivial logic of 12 methods sank into domain Services; klient/node-sdk/kap-server all switched to direct access | PR #2871 |
| 2026-08-13 | **v2 scan** (PR #2886): Feature contribution discoverability metadata retracts with the provider lifecycle; the user decided "only one provider per `(scope,id)`, duplicates throw immediately" | PR #2886 |
| 2026-08-17 → 08-20 | **agent-session-domain** (PR #3103, merged 08-20 `a09d9041`): established the target architecture "every Domain becomes a Feature itself"; Model-as-container phase one (`AgentModel`/`defineAgentModel`/`AgentContext.space`); `AgentEvent2` (agentId in payload) + a single Session EventBus; Todo/Usage/TokenCounting migrated first | PR #3103 |
| 2026-08-20 → 08-23 | **agent-domain-model migration** (PR #3175, merged 08-23 `368b4b74`): delivered Agent Runtime infrastructure (opaque contract/provider, `AgentLifecycleService→ManagedAgent→AgentRuntimeSet`, restore as the single owner) + Todo/Cron/Interaction migrated to Runtime; goal/skill/reminder/dateChange followed | PR #3175 |
| 2026-08-25 → 09-07 | **remaining agent domains** (PR #3303, **closed unmerged 2026-09-07**): migrate all remaining Agent domains to Agent Runtime; step 13 would eliminate the Agent DI scope in favor of an explicitly-constructed `AgentHost` object (once completed in the working copy); **2026-09-07 user decision: abandon this refactoring route, archive the work item** | PR #3303 (closed unmerged) |
| 2026-09-01 → 09-07 | **remove agent-core v1** (PR #3542): deleted `packages/agent-core` (687 files); node-sdk migrated fully to v2 (17 modules of contracts made self-owned); `createKimiHarnessV2` renamed to `createKimiHarness` as the sole factory; `KIMI_CODE_LEGACY_FLAG` and vscode `useAgentCoreV1` deleted with it; its rebase baseline is this document's checkout `ccf3d5d6` | PR #3542 |

Additional fact: the v2 package's `docs/features.md` (the old Agent Runtime implementation standard) **no longer exists** at this baseline (deleted in the documentation cleanup); at the baseline `docs/` holds only the wire/state/config manifests, and this migration guide (EN/zh) is added on top of that baseline.

### 5.2 Key architectural decisions (with original basis)

**Why RPC left the engine** (the v2 agent-rpc removal; the user story is the decision record):

- "Delete the facade-style aggregating `AgentRPCService`, eliminate the dual-track mental burden of 'should the edge go RPC or direct domain service', and let orchestration logic exist in exactly one place — the domain Service" (v2 agent-rpc removal decision record);
- "The wire contract and in-process call semantics must agree … no implicit knowledge like 'can a Promise cross the wire'" (`PromptHandle.launched` contains a Promise; a `Turn` cannot cross the klient wire) (same decision record);
- landing spots: protocol types → `packages/protocol` + `packages/klient`, server implementation → `packages/kap-server`, in-process events → `IEventBus` + `Event2` (the main document's §2.4 table).

**Why single-process**:

- The direct evidence is resultative statement: the main document A.1 "`services/` … `coreProcess/` gone (v2 is single-process)" and A.3 "`coreProcess` → gone (v2 is in-process DI, with kap-server at the edge)"; on the v1 side, `CoreProcessService` is the cross-process adapter holding the `CoreRPC` mega-proxy (`services/coreProcess/coreProcess.ts:1-29` + the role table in services/AGENTS.md:38).
- The kap layering decision (in-process adapter form) is in the kap edge adapters work item: on 2026-08-13 the user ratified the architecture diagram placing all adapters in `kap-in-memory`, directly connected to the engine package. **Unverified**: no explicit "why single-process" decision paragraph appears in the four designated decision records; what can be cited is the resultative statements above plus the kap edge adapters diagram resolution.

**Why no compatibility layer**:

- the agent-domain-model migration's inherited constraint (user decision): "compatibility bridges that already use `IAgentXxx`/`AgentXxxBinding` must be deleted with the Runtime migration; **no new generic aliases as synonym transition layers**; callers switch directly to the execution context or `AgentManager.resolve`" (agent-domain-model migration decision record);
- remaining agent domains: "features.md forbids leaving DI facade transitions; every reverse edge must be flipped in the same changeset as its domain's migration" (decision record); "transition bridges live uniformly inside the not-yet-migrated old services … no compatibility interfaces on the new Runtime side" (same decision record);
- Engineering discipline in writing: the main document §3.3 "Do not add compatibility shims for v1 shapes inside the v2 engine. Shims live only in consumers"; the root AGENTS.md: "when refactoring, do not assume compatibility costs — design for the lowest global complexity";
- The endgame: remove agent-core v1 deleted the v1 package itself together with `KIMI_CODE_LEGACY_FLAG` — "v2 unconditionally in effect" (remove agent-core v1 decision record).

**Why the Feature seam**:

- agent-session-domain background: "instead of moving capabilities into a new Session facade, registry, or runtime bundle, let each Domain become a Feature itself: the Domain Feature registers its own Model, Effect, Event, Tool, and Session Service; the Domain Service consumes those contributions itself" (agent-session-domain decision record); the user constraint: "do not introduce any facade, registry, RuntimeBundle, or equivalent central object responsible for cross-Domain integration, binding, or materialization" (decision record); "a Domain Feature only registers definitions; it must not create future-Agent runtime instances at install time" (same decision record);
- Relationship to v1's services layer: a Feature is one Fiber unit at App scope (`Feature extends Service`); contributing is dropping collection records, and materialization/reclamation is managed by infrastructure (the ScopeUnits watcher, the cascade) — compare v1's "self-registration at the bottom of each impl file + one-shot seeding of the root container", a static all-on pattern: v2's registration unit carries a lifecycle (unloadable, config-updatable, discoverable).
- **Critical caveat**: the agent-domain-model migration and the remaining agent domains work narrowed the Agent-granular extension point further into a single-argument `contributeAgentRuntime(definition)` form (decision record), **but that route was archived and never landed**. The Feature seam at this baseline is exactly the mechanism in §4 (contributeService/Tool/Config/Model, etc.), and the Agent granularity is still a DI scope. The target end-state of those work items — the Agent Runtime / `AgentHost` two-tier topology (App→Session, Agent DI scope deleted) — **was never merged into main**; it is recorded here only as historical decision background. The current reality of this baseline = **three DI LifecycleScope tiers (App / Session / Agent) + Program as the workspace-level generation concept + the Feature seam**. Do not read the target end-state into the current architecture.

## Open verification items

1. ~~**The "four LifecycleScope tiers" wording**~~ (resolved 2026-09-19): the main document (`migration-from-v1.md:21` and its zh-CN mirror :21) has been corrected to three tiers (App / Session / Agent; workspace-level = `Program`, `program/program.ts:113` + App-scope `IWorkspaceInstanceManager`).
2. **A primary source for "why single-process"**: no dedicated paragraph in the four designated decision records; the available evidence is the resultative statements in the main document (A.1/A.3) + the user-ratified architecture diagram in the kap edge adapters record. For a stronger first-hand "why", check the records of the initial v2 package creation or the earlier v2 package work (not expanded here).
3. **v2 package creation date**: v2 already existed by the v2 agent-rpc removal (2026-08-12); the package-creation work item itself is not among the four designated documents, so the timeline start is marked "no later than 2026-08-12".
4. the remaining agent domains' Agent Runtime/`AgentHost` end-state (two-tier topology) **was never merged into main**; any writing must avoid describing the target end-state as the current architecture of this baseline; the current reality = three DI scopes + the Feature seam of §4.
5. **Post-baseline drift (unverified)**: the `packages/protocol` references in §5.2 were verified at the declared baseline `ccf3d5d6`; in the current workspace checkout (main after #3542) the package no longer exists at that location. The decision narrative remains a baseline fact; the package's post-baseline relocation is pending verification.
