# Features — self-contained built-in capabilities

A **Feature** is a built-in capability (plan mode, and later mcp, …) authored as ONE
self-contained unit under `src/features/<name>/`. The Feature unit is the single place
that declares everything the capability contributes to the engine; retracting the unit
withdraws all of it across the scope tree (连坐).

`plan` is the reference implementation: `src/features/plan/` (extracted from
`agent/plan` + `agent/tools/plan`).

## The base class

```ts
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

export class PlanFeature extends Feature {
  static override readonly name = 'plan';   // stable unit name (the assembly keys by it)

  constructor() {
    super();
    this.contributeAgentService(IAgentPlanService, AgentPlanService);
    this.contributeTool(IEnterPlanModeTool, EnterPlanModeTool, { name: 'EnterPlanMode', domain: 'plan' });
    this.contributeTool(IExitPlanModeTool, ExitPlanModeTool, { name: 'ExitPlanMode', domain: 'plan' });
    this.onDispose(() => { /* cleanup */ });
  }
}

registerFeature(PlanFeature);   // import = register
```

`Feature extends Service`, so every contribution runs through the normal two-phase
construction protocol (declare contributions in the constructor; they are buffered and
flushed by the kernel). The helpers are thin compositions over the existing seams:

| Helper | Composition | Semantics |
|---|---|---|
| `contribute(token, value)` | `this.provide(token, value)` | raw collection record |
| `contributeService(scope, id, ctor, opts?)` | `ScopeUnits(scope)` function recipe | one live unit per present AND future scope of that kind; retracted everywhere when the feature dies |
| `contributeAgentService(id, ctor, opts?)` | `contributeService(LifecycleScope.Agent, …)` | the common case |
| `contributeTool(id, ctor, options)` | per-agent `OnDemand` registration + `AgentToolContribution` record | the tool ctor keeps full `@IXxx` DI; the activation fold filters by name before constructing |
| `contributeProfiles(profiles, opts?)` | `AgentProfileContribution` record | `sourceId` defaults to `feature:<name>` |
| `contributeConfig(domain, schema, options?)` | `ConfigSectionContribution` record | see the static-channel rule below before using |
| `contributeCommand({ name, description?, run })` | `CommandContribution` record | runs engine-side; `ctx.get(id)` resolves through the agent container and is valid only during the synchronous part of `run` (resolve up front, then `await`) |
| `onDispose(fn)` | `this._register(toDisposable(fn))` | cleanup on retraction |

## Assembly lifecycle

1. A feature module calls `registerFeature(Recipe)` at its top level
   (`src/features/featureRegistry.ts` holds the module table).
2. `src/index.ts` imports the feature leaf (`import '#/features/plan/planFeature';`),
   so importing the package registers it.
3. At App-scope creation the `IFeatureAssemblyService`
   (`src/features/featureAssemblyService.ts`) drains the table and assembles each
   recipe through `IFeatureManager.provideUnit` — the same provide path as static
   scope batches. Every feature is named, introspectable (`IFeatureManager.units()`,
   visible in the kimi-inspect DI view), and individually retractable
   (`unprovideUnit(name)` / `updateUnit(name, config)`).
4. Per-scope materialization goes through the kernel's `ScopeUnits` fold: a service a
   feature contributes at Agent scope appears in every existing and future Agent scope,
   bound by the same cascade rules as a static registration.

## Static channels vs Feature channels (the rule for built-in features)

Some contribution kinds must stay on the **static import=register channels** even when
they belong to a feature:

- **Config sections** (`registerConfigSection`) — the config manifest generator
  (`scripts/gen-config-manifest.mts`) drains the module-level table and statically scans
  for call sites; a runtime-only contribution would vanish from
  `docs/config-manifest.toml`.
- **Agent profiles** contributed via `registerAgentProfile` — same static-table
  reasoning.
- **Wire vocabulary** (durable `Event2` classes /
  `defineState(...).replayable(...)`) — wire records must remain replayable even if the
  feature unit is retracted.

The Feature unit carries the **runtime capabilities**: services, tools, commands, hook
subscriptions. `PlanFeature` is the example: `configSection.ts` and `profile/plan.ts`
keep their static registrations; the service and the two tools go through the Feature.

## Events and hooks inside a feature

- Agent-scope services a feature contributes can use the string form of the unit `on`
  capability — `this.on('turn.ended', …)` — backed by the production `FiberEventResolver`
  (`src/app/event/fiberEventResolver.ts`), which resolves the event against the scope's
  `IEventBus` (attaching lazily if the bus is not materialized yet). Constructor
  injection of `@IEventBus` + `subscribe` remains the fully explicit equivalent.
- Tool-call guards (e.g. the plan-mode write veto) subscribe to
  `IAgentToolExecutorService.onBeforeExecuteTool` inside the contributed Agent-scope
  service — see `src/features/plan/planService.ts` for the canonical veto-listener
  pattern.

## Adding a new feature

1. `src/features/<name>/` — domain files follow the usual conventions (no comments,
   one service per file pair, `.md?raw` assets move with the feature).
2. `<name>Feature.ts` — the Feature subclass + `registerFeature(...)`.
3. `src/index.ts` — precise leaf imports/exports; no barrel.
4. Tests in `test/features/<name>/`; for the assembly mechanics mirror
   `test/features/feature.test.ts` (scoped host, `registerFeature` before
   `createScopedTestHost`).
5. If the feature registers agent-state keys, `scripts/gen-state-manifest.mts` resolves
   the scope of `.register(key)` call sites under `src/features/**` from the receiver's
   `I{App,Workspace,Session,Agent}StateService` type — register through a member typed
   as the scope's state service. Regenerate the manifests
   (`pnpm gen:config-manifest && pnpm gen:wire-manifest && pnpm gen:state-manifest`).
