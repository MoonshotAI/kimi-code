# `@moonshot-ai/services`

In-process service container for the kimi-code daemon. Every public
member follows the VSCode platform-service convention so DI wiring,
docstrings, and call-site ergonomics stay uniform.

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
| Cross-process adapter | `readonly rpc: ...` + `ready(): Promise<void>` | `ICoreProcessService` |

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
      coreProcess.ts          ← ICoreProcessService, CoreProcessServiceOptions
      coreProcessService.ts   ← CoreProcessService implements ICoreProcessService

This mirrors `vscode/src/vs/platform/<domain>/common/<domain>.ts` +
`<domain>Service.ts`.

## Out of scope (intentionally deferred)

The following are recognised as VSCode-aligned improvements but **NOT**
covered by this convention today; they would be follow-up refactors:

1. **Split `ICoreProcessService.rpc` (current `CoreRPC` mega-proxy)
   into per-domain typed slices**, so a `SessionService` only sees
   `Pick<CoreRPC, 'createSession' | 'listSessions' | ...>` and not the
   entire `CoreAPI`. Pure soft slicing (no `agent-core` changes) gives
   us boundary discipline + test ergonomics without the IPC-channel
   cost.
2. **Dissolve `IEventService`** into per-service typed `Event<T>`
   properties wired off a single core stream. The first step is done:
   `IEventService` is now a transport-agnostic pure pub-sub bus
   (`publish` + `onDidPublish`) and the daemon's WS-specific concerns
   (per-session seq, ring buffer, WS fan-out, replay) live on a separate
   daemon-only `IWSBroadcastService` that subscribes to the bus. The
   remaining step is folding the central stream into per-domain typed
   emitters on each `IXxxService` so consumers can subscribe to a
   narrow `Event<T>` rather than the full firehose.
3. **Real channel registry** (`getChannel(name) / registerChannel(...)`
   on `ICoreProcessService`) mirroring VSCode's `IMainProcessService`.
   Requires `agent-core` RPC layer changes.

When taking on (1) or (2), the new types still follow the rules above —
no new suffixes get reintroduced.

## Per-domain layout (current)

| Folder | Contracts | Impl | Decorator |
|---|---|---|---|
| `coreProcess/` | `coreProcess.ts` | `coreProcessService.ts` | `ICoreProcessService` |
| `event/` | `event.ts` | `eventService.ts` | `IEventService` |
| `approval/` | `approval.ts` | (impl lives in daemon) | `IApprovalService` |
| `question/` | `question.ts` | (impl lives in daemon) | `IQuestionService` |
| `environment/` | `environment.ts` | (impl lives in daemon) | `IEnvironmentService` |
| `session/` | `session.ts` | `sessionService.ts` | `ISessionService` |
| `message/` | `message.ts` | `messageService.ts` | `IMessageService` |
| `prompt/` | `prompt.ts` | `promptService.ts` | `IPromptService` |
| `tool/` | `tool.ts` | `toolService.ts` | `IToolService` |
| `mcp/` | `mcp.ts` | `mcpService.ts` | `IMcpService` |
| `task/` | `task.ts` | `taskService.ts` | `ITaskService` |
| `oauth/` | `oauth.ts` | `oauthService.ts` | `IOAuthService` |
| `authSummary/` | `authSummary.ts` | `authSummaryService.ts` | `IAuthSummaryService` |

Adding a new service: create the folder + contracts + impl pair, add a
bottom-of-file `registerSingleton(IXxxService, XxxService,
InstantiationType.Delayed)` in the impl, add the corresponding side-effect
import to `module.ts`, re-export from `index.ts`. The daemon's `start.ts`
consumes `defaultServicesModule()` for descriptor-only services; only override
the registry entry (via `services.set(I, prebuiltInstance)` or
`services.set(I, new SyncDescriptor(C, [runtimeArgs], false))`) when the
service needs an external handle or runtime static args that the registry
can't supply.

## Service registration (normative)

`@moonshot-ai/services` uses the registry-based wiring pattern modelled on
`vscode/src/vs/platform/extensions/common/extensions.ts`.

1. **Each `<X>Service.ts` impl file self-registers** at the bottom:

   ```ts
   import { registerSingleton, InstantiationType } from '@moonshot-ai/agent-core';
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

2. **`defaultServicesModule()` is a thin projection** of
   `getSingletonServiceDescriptors()`. It does NOT maintain a separate
   list — `module.ts`'s only responsibility is the side-effect import
   list that populates the registry plus the
   `InstantiationType.Delayed | Eager` projection.

3. **Daemon-side `services.set(...)` may override** the registry-derived
   entry for services that need runtime static args (e.g.
   `services.set(ICoreProcessService, new SyncDescriptor(CoreProcessService,
   [opts.coreProcessOptions ?? {}], false))` in `start.ts`) or for
   prebuilt instances carrying external closures (`PinoLogger`,
   `FastifyRestGateway`). The duplicate-registration throw was removed
   from `registerSingleton` (plan §158); the later registration wins at
   every layer.

The legacy "hand-built array in `module.ts`" pattern that lived here
through Phase 2 is gone. Do NOT reintroduce it — extending the array in
`module.ts` no longer has any effect on what the daemon resolves.

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

