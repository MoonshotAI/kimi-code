# @moonshot-ai/services

In-process service container for the Kimi Code server: a set of typed
dependency-injection services plus the `CoreProcessService` in-process RPC
adapter. Every public member follows the VSCode platform-service convention so
DI wiring, docstrings, and call-site ergonomics stay uniform.

This package is **private** — it is consumed by `@moonshot-ai/server` and is not
published on its own.

## What it provides

A collection of `IXxxService` contracts and their `XxxService` implementations,
one folder per domain, wired through a `ServiceCollection`. The container is
seeded from `getSingletonServiceDescriptors()`; each implementation file
self-registers via `registerSingleton(...)` at the bottom of the file.

| Domain | Decorator | Role |
|---|---|---|
| `coreProcess/` | `ICoreProcessService` | In-process RPC adapter to `agent-core` |
| `session/` | `ISessionService` | Session lifecycle |
| `message/` | `IMessageService` | Messages |
| `prompt/` | `IPromptService` | Prompt submission |
| `tool/` | `IToolService` | Tool execution |
| `task/` | `ITaskService` | Background tasks |
| `mcp/` | `IMcpService` | MCP servers |
| `oauth/` | `IOAuthService` | OAuth flows |
| `authSummary/` | `IAuthSummaryService` | Auth summary |
| `workspace/` | `IWorkspaceRegistry`, `IWorkspaceFsService` | Workspace registry + FS |
| `fs/` | `IFsService`, `IFsSearchService`, `IFsGitService`, `IFsWatcher` | File system, search, git, watching |
| `fileStore/` | `IFileStore` | File store |
| `event/` | `IEventService` | Transport-agnostic pub-sub bus |
| `approval/` | `IApprovalService` | Approval broker (impl in server) |
| `question/` | `IQuestionService` | Question broker (impl in server) |
| `environment/` | `IEnvironmentService` | Environment (impl in server) |
| `logger/` | `ILogService` | Logging (adapter in server) |

## Conventions (summary)

The normative rules live in [`AGENTS.md`](./AGENTS.md); the short version:

- **Every injectable uses the `Service` suffix** — no `Bus`, `Broker`,
  `Bridge`, `Registry`, or `Manager`. The role is conveyed through the
  docstring and interface shape, not the suffix.
- **One folder per domain, camelCase**, no kebab: `coreProcess/`, not
  `core-process/`.
- **Contracts file** = `<domain>.ts` (interface, decorator, sentinel errors);
  **impl file** = `<domain>Service.ts` (the class). The impl imports the
  decorator + interface from the sibling contracts file.
- **Self-registration:** each impl file ends with
  `registerSingleton(IXxxService, XxxService, InstantiationType.Delayed)`.
  Importing `@moonshot-ai/services` runs these side effects.
- **No comments by default** — write a comment only when the *why* is
  non-obvious. See `AGENTS.md` for the full rule.

## Consuming it

```ts
import { getSingletonServiceDescriptors, IPromptService } from '@moonshot-ai/services';
import { ServiceCollection, InstantiationService } from '@moonshot-ai/agent-core';

const services = new ServiceCollection(...getSingletonServiceDescriptors());
const ix = new InstantiationService(services);

const prompt = ix.invokeFunction((a) => a.get(IPromptService));
await prompt.submit(/* ... */);
```

Server bootstrap (`packages/server/src/services/serviceCollection.ts`) is the
canonical example: it spreads `getSingletonServiceDescriptors()`, then overrides
entries that need runtime arguments or prebuilt instances via `services.set(...)`.

## Scripts

```bash
pnpm --filter @moonshot-ai/services typecheck   # tsc --noEmit
pnpm --filter @moonshot-ai/services test        # vitest run
pnpm --filter @moonshot-ai/services build       # tsdown
```

## Related packages

- `@moonshot-ai/server` — the consumer that wires these services into a
  running REST + WebSocket server. See `packages/server/README.md`.
- `@moonshot-ai/agent-core` — provides the DI primitives
  (`createDecorator`, `ServiceCollection`, `InstantiationService`,
  `registerSingleton`).
- `@moonshot-ai/protocol` — wire types shared with the server and clients.
