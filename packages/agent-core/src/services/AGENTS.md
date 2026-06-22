# In-process services (`packages/agent-core/src/services`)

In-process service layer for the kimi-code server, now hosted inside
`@moonshot-ai/agent-core` (merged from the former `@moonshot-ai/services`
package). Every public member follows the VSCode platform-service convention
so DI wiring, docstrings, and call-site ergonomics stay uniform.

This subtree is agent-core's "upper facade" layer: it may depend on the
agent-core runtime (`rpc/`, `session/`, `agent/`, `di/`, …) via relative
imports, but the runtime must not import back into `services/`. Each file
imports agent-core internals from the specific submodule (e.g.
`../../di`, `../../rpc`) rather than the top-level barrel, to keep the
dependency graph acyclic.

## Naming convention (normative)

Every injectable thing in this package uses the **`Service`** suffix.
No `Bus`, no `Broker`, no `Bridge`, no `Registry`, no `Manager`.

- **Decorator**: `export const IXxxService = createDecorator<IXxxService>('xxxService')`
- **Interface**: `export interface IXxxService { readonly _serviceBrand: undefined; ... }`
- **Class**: `export class XxxService implements IXxxService { ... }`
- **Decorator string** (3rd arg of `createDecorator`): lowerCamelCase
  of the interface name minus the leading `I` — `xxxService`. This
  string surfaces in `CyclicDependencyError.path` and `No service
  registered for identifier ...` messages, so it must be unique and
  stable.

The role (business facade / one-shot reverse-RPC broker / pub-sub bus /
cross-process RPC adapter) is communicated through the **docstring**
and the **interface shape**, not the suffix. Patterns:

| Role | Interface signature | Example |
|---|---|---|
| Business facade | mostly `Promise<T>` returns | `IPromptService.submit(...)` |
| One-shot broker | `request(req): Promise<resp>` + `resolve(id, resp)` | `IApprovalService` |
| Pub-sub bus | `publish(e)` + `readonly onDidXxx: Event<T>` | `IEventService` |
| Cross-process adapter | `readonly rpc: ...` + `ready(): Promise<void>` | `ICoreRuntime` |

## File / folder convention (normative)

- One folder per domain, **camelCase**, no kebab: `coreProcess/`,
  `authSummary/`, NOT `core-process/`, NOT `auth-summary/`.
- **Contracts** file = `<domain>.ts` (camelCase, no `Service` suffix).
  Holds the interface, decorator, sentinel errors, adapter helpers,
  and protocol↔in-process shape translations.
- **Impl** file = `<domain>Service.ts` (camelCase, with `Service`
  suffix). Holds the concrete class. Imports the decorator + interface
  from the sibling contracts file.

Example domain layout:

    coreProcess/
      coreProcess.ts          ← ICoreRuntime, CoreProcessServiceOptions
      coreProcessService.ts   ← CoreProcessService implements ICoreRuntime
      coreProcessClient.ts    ← BridgeClientAPI (SDK-side RPC dispatch)

`ICoreRuntime` is the sole identifier for the core-process adapter; the
deprecated process-service alias was removed. Its decorator string remains
`'coreProcessService'` (rename deferred), so the DI token is stable across
the rename.

This mirrors `vscode/src/vs/platform/<domain>/common/<domain>.ts` +
`<domain>Service.ts`.

## Domain decomposition (normative)

A domain folder MAY decompose into up to five roles when the aggregate's
concerns warrant the split. Not every domain needs all five — introduce a
role only when it has a clear owner and a non-empty contract. The
`<domain>.ts` + `<domain>Service.ts` layout above is the **command** role
for a single-write-owner domain; the roles below extend it.

| Role | File | Interface | Purpose | Introduce when |
|---|---|---|---|---|
| command | `<domain>Service.ts` | `I<Domain>Service` | Aggregate mutations/writes: create / update / archive / restore / purge / fork. The only write entry point for the aggregate. | The aggregate has a lifecycle that needs a stable owner. |
| query | `<domain>QueryService.ts` | `I<Domain>QueryService` | Read models: list / search / count across scopes. No side effects. | The aggregate is listed / searched / counted under more than one scope. |
| runtime | `<domain>RuntimeService.ts` | `I<Domain>RuntimeService` | Event-driven live state: per-id status / live state and status-change subscriptions. A projection, not truth. | The aggregate has live state derived from in-process objects / event streams that must not be written back to truth. |
| repository | `<domain>Repository.ts` | `I<Domain>Repository` | Single-entity persistence: create / get / update and archive / restore / delete as atomic ops. Holds the aggregate's truth. | The aggregate persists and needs a single source of truth behind the service layer. |
| index | `<domain>Index.ts` | `I<Domain>Index` | Read-model summary index: upsert / remove / list / count over Summary rows. | list / search would otherwise scan truth; the index keeps one read model. |

`repository` and `index` are persistence-layer contracts (Domain /
Persistence in the service-skill concept docs), not application services —
they sit below command / query / runtime and are not registered as
top-level `*Service` singletons.

#### Where repositories and indexes live (normative)

The roles table above describes the *shape* of a repository/index contract;
its *home* depends on which layer consumes it directly:

- **Repositories and indexes consumed directly by a runtime aggregate live in
  the runtime layer** (for example `src/session/sessionRepository.ts`,
  `src/session/<...>Index.ts`). They are colocated with the runtime aggregate
  that owns them because the runtime must not import from `services/` (the
  dependency-direction fence below). They are NOT `*Service` DI singletons
  and are NOT under `services/`.
- **Command / query / runtime facades and read-model services consumed at the
  RPC / SDK boundary live under `services/<domain>/`**. Those facades depend
  on the runtime repositories / indexes (services → runtime is allowed) and
  expose them upward.

This does not change the dependency direction: the runtime never imports from
`services/`; repositories/indexes live in whichever layer consumes them, and
the `services/` facades depend on them — never the reverse.

### Dependency direction within a domain (normative)

These rules are enforced by the ROADMAP and checked by the M7.2 import fence:

- `repository/` and `index/` do NOT depend on the application service layer
  (command / query / runtime). They are the layer the services sit on.
- Within a domain, the command / query / runtime roles do NOT call each
  other's business methods. Cross-role effects compose through domain events
  / lifecycle hooks, not direct business calls. A query needing per-id
  enrichment, or a command needing a sibling read, goes through the lower
  layer (`index` / `repository`) or an event.
- The runtime↔services rule at the top of this file still holds: `services/`
  may import the agent-core runtime; the runtime must not import back into
  `services/`.

### Migration gate (normative)

Before any domain's migration milestone starts, that domain MUST have a
finalized concept doc at
`.agents/skills/service-skill/explanation/domains/<domain>.md`, plus any
supporting notes under
`.agents/skills/service-skill/reference/domains/<domain>/`. No concept doc
→ the milestone does not start. This restates the gate in the ROADMAP global
constraints.

### How to add a domain (normative)

1. **Concept doc first.** Finalize
   `.agents/skills/service-skill/explanation/domains/<domain>.md` (plus any
   `reference/domains/<domain>/` notes) before the milestone starts — the
   migration gate above blocks otherwise.
2. **Pick the roles.** Start with the command role
   (`<domain>.ts` + `<domain>Service.ts`). Add `query` / `runtime` only
   when the aggregate has a second read scope or live state; add
   `repository` / `index` when it owns truth or needs a read-model index.
   Empty roles are not created.
3. **Apply the layering rule.** `repository` / `index` sit below the
   service layer and live where they are consumed — colocated with the
   runtime aggregate when the runtime owns them, never imported by
   `services/`. Command / query / runtime facades consumed at the RPC /
   SDK boundary live under `services/<domain>/` and depend on those
   repositories / indexes (services → runtime, never the reverse).
4. **Register.** Self-register each impl with
   `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)`
   and re-export contracts + impl from `index.ts` so the package barrel
   runs the side effect. `repository` / `index` are not top-level
   singletons.
5. **Fence.** The M7.2 dependency-direction test enforces runtime ↛
   services, repository/index ↛ services, and no cross-service business
   imports. New domains must keep it green; the within-domain
   cross-role rule is code-review convention, not grep-enforced.

### Reference index

- command — [`command-service.md`](../../../../.agents/skills/service-skill/reference/patterns/command-service.md)
- query — [`query-service.md`](../../../../.agents/skills/service-skill/reference/patterns/query-service.md)
- runtime — [`runtime-service.md`](../../../../.agents/skills/service-skill/reference/patterns/runtime-service.md)
- repository + index — [`repository-and-index.md`](../../../../.agents/skills/service-skill/reference/patterns/repository-and-index.md)

## Out of scope / completed

Done by the DI domain-runtime-services refactor:

1. **CoreRPC slicing** — facades no longer depend on the `CoreRPC`
   mega-proxy. Each routes to the in-process `CoreAPI` through
   `ICoreRuntime.getCoreApi()` (zero-serialization) or through peer
   domain services, so a `SessionService` only sees the methods it
   actually calls.
2. **Domain decomposition** — domains split into command / query /
   runtime / repository / index roles when the aggregate warrants it
   (e.g. `session/` → `ISessionService` + `ISessionQueryService` +
   `ISessionRuntimeService`; `SessionRepository` + `SessionIndex` live in
   the runtime layer). See the roles table above.
3. **Event projection boundary** — domain lifecycle hooks
   (`onSessionWillStart`, `onSessionWillClose`, `onAgentWillResume`, …)
   carry the cross-cutting effects that used to be hard-wired, and the
   `IDomainEventBus` + `event/projection` boundary turns core events into
   protocol events. `IEventService` stays a transport-agnostic pub-sub
   bus (`publish` + `onDidPublish`); WS fan-out remains on the
   server-only `IWSBroadcastService`.

Still deferred (would be follow-up refactors):

1. **Per-domain typed emitters** — fold the central `IEventService`
   firehose into narrow `Event<T>` properties on each `IXxxService`, so
   consumers subscribe to a domain stream rather than the full bus.
2. **Real channel registry** (`getChannel(name) / registerChannel(...)`
   on `ICoreRuntime`) mirroring VSCode's `IMainProcessService`.
   Requires agent-core RPC layer changes.

When taking on either, the new types still follow the rules above — no
new suffixes get reintroduced.

## Per-domain layout (terminal)

| Folder | Contracts | Impl | Decorator |
|---|---|---|---|
| `coreProcess/` | `coreProcess.ts` | `coreProcessService.ts`, `coreProcessClient.ts` | `ICoreRuntime` |
| `event/` | `event.ts` | `eventService.ts` | `IEventService` |
| `approval/` | `approval.ts` | (impl lives in server) | `IApprovalService` |
| `question/` | `question.ts` | (impl lives in server) | `IQuestionService` |
| `environment/` | `environment.ts` | (impl lives in server) | `IEnvironmentService` |
| `logger/` | `logger.ts` | (adapter lives in server) | `ILogService` |
| `fileStore/` | `fileStore.ts` | `fileStoreService.ts` | `IFileStore` |
| `fs/` | `fs.ts`, `fsSearch.ts`, `fsGit.ts`, `fsWatcher.ts`, `fsPathSafety.ts` | `fsService.ts`, `fsSearchService.ts`, `fsGitService.ts`, `fsWatcherService.ts` | `IFsService`, `IFsSearchService`, `IFsGitService`, `IFsWatcher` |
| `workspace/` | `workspaceRegistry.ts`, `workspaceFs.ts`, `workspace.ts` | `workspaceRegistryService.ts`, `workspaceFsService.ts`, `workspaceService.ts` | `IWorkspaceRegistry`, `IWorkspaceFsService`, `IWorkspaceService` |
| `config/` | `config.ts` | `configService.ts` | `IConfigService` |
| `session/` | `session.ts` | `sessionService.ts`, `sessionQueryService.ts`, `sessionRuntimeService.ts` | `ISessionService`, `ISessionQueryService`, `ISessionRuntimeService` |
| `message/` | `message.ts` | `messageService.ts` | `IMessageService` |
| `prompt/` | `prompt.ts` | `promptService.ts` | `IPromptService` |
| `tool/` | `tool.ts` | `toolService.ts` | `IToolService` |
| `mcp/` | `mcp.ts` | `mcpService.ts` | `IMcpService` |
| `modelCatalog/` | `modelCatalog.ts` | `modelCatalogService.ts` | `IModelCatalogService` |
| `skill/` | `skill.ts` | `skillService.ts` | `ISkillService` |
| `task/` | `task.ts` | `taskService.ts` | `ITaskService` |
| `oauth/` | `oauth.ts` | `oauthService.ts` | `IOAuthService` |
| `authSummary/` | `authSummary.ts` | `authSummaryService.ts` | `IAuthSummaryService` |
| `terminal/` | `terminal.ts` | `terminalService.ts` | `ITerminalService` |
| `plugin/` | (runtime, not under `services/`) | `#/plugin` | (not a DI service facade) |

`plugin/` is a runtime-layer aggregate at `src/plugin/` (imported as
`#/plugin`), consumed by `services/` facades rather than exposing a
`*Service` of its own. It is listed here so the boundary is explicit: the
runtime owns plugin loading / manifests / storage; `services/` only
projects it upward.

Adding a new service: create the folder + contracts + impl pair, add a
bottom-of-file `registerSingleton(IXxxService, XxxService,
InstantiationType.Delayed)` in the impl, then re-export the contracts and impl
from `index.ts` so importing `@moonshot-ai/agent-core` runs the registration
side effect. Server bootstrap consumes `getSingletonServiceDescriptors()` for
descriptor-only services; only override the registry entry (via
`services.set(I, prebuiltInstance)` or `services.set(I, new SyncDescriptor(C,
[runtimeArgs], false))`) when the service needs an external handle or runtime
static args that the registry can't supply.

## Service registration (normative)

This layer uses the registry-based wiring pattern modelled on
`vscode/src/vs/platform/extensions/common/extensions.ts`.

1. **Each `<X>Service.ts` impl file self-registers** at the bottom:

   ```ts
   import { registerSingleton, InstantiationType } from '../../_base/di';
   // …class body…
   registerSingleton(IXxxService, XxxService, InstantiationType.Delayed);
   ```

   - Prefer `InstantiationType.Delayed` (the default). The container returns a
     `Proxy` that defers real construction until the first method call, which
     avoids paying ctor cost for services that are registered but never used
     in a given session.
   - Use `InstantiationType.Eager` only when the service must exist before any
     consumer touches it (e.g. `ILogService` so early errors are captured).
   - When the ctor takes a leading data-bag prefix (e.g.
     `CoreProcessService`'s `options`), fall back to the descriptor overload:
     `registerSingleton(IXxxService, new SyncDescriptor(XxxService, [optionsBag]))`.

2. **Consumers seed from `getSingletonServiceDescriptors()` directly**.
   Importing `@moonshot-ai/agent-core` loads the package barrel, whose impl
   re-exports run the `registerSingleton(...)` side effects.

3. **Server-side `services.set(...)` may override** the registry-derived
   entry for services that need runtime static args (e.g.
   `services.set(ICoreRuntime, new SyncDescriptor(CoreProcessService,
   [opts.coreProcessOptions ?? {}], false))` in `start.ts`) or for
   prebuilt instances carrying external closures (`PinoLogger`,
   `FastifyRestGateway`). `registerSingleton` does not throw on a
   duplicate id; the later registration wins at every layer.

The legacy "hand-built array" and `defaultServicesModule()` wrapper patterns
are gone. Do NOT reintroduce them — the registry is the source of truth, and
bootstrap code should read it with `getSingletonServiceDescriptors()`.

## Comments (normative)

Default to **no comments**. Well-named identifiers and types already say
WHAT the code does; a comment that restates that just decays as the code
changes around it.

Write a comment only when the **WHY** is non-obvious to a reader who
has the diff in front of them: a hidden constraint, a subtle invariant,
a workaround for a specific upstream bug, behavior that would surprise
someone reading the call. One short line max.

Do **not** write:

- Block / paragraph docstrings on internal helpers.
- Comments that narrate the diff itself ("now we call resumeSession
  first so cold sessions auto-load") — that belongs in the commit
  message and PR description, not in the source. The next reader has
  no diff context; they just see prose that drifts as the surrounding
  code evolves.
- Comments that re-explain types already visible at the call site
  ("returns `Promise<Session>`", "throws `SessionNotFoundError`").
- Comments pointing at other files by line number (`core-impl.ts:286-289`).
  Line numbers move; the pointer rots within a release.
- "Regression guard for …" / "fixes the bug where …" preambles on
  tests. The test name and assertions are the contract; the bug
  history belongs in git.

Existing files in this package over-comment by historical accident.
**Do not propagate that style to new code.** When touching an existing
file, prefer leaving the surrounding comments alone — large comment
deletions belong in their own dedicated cleanup pass, not bundled into
behavior changes.
