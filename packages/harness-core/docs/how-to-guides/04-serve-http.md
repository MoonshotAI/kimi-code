# Serve HTTP

The HTTP transport is itself a feature: `createHttp` mounts a server at the
app level, registers the built-in route layers, and lets any other feature
contribute routes and WebSocket endpoints through the same mechanism. This
guide covers mounting it and adding your own routes.

## Mount the Transport

```ts
import { createHarness, createHttp } from '@moonshot-ai/harness-core';

const harness = createHarness();
await harness.app.features.add(
  createHttp({
    listen: { port: 8787, host: '127.0.0.1' },
    corsOrigins: ['https://example.com'],
    version: '1.2.3',
  }),
);
```

`CreateHttpOptions`:

| Option | Default | Meaning |
|---|---|---|
| `server` | created via `createHttpServer({ corsOrigins })` | bring your own `Http` — then the feature neither calls `listen` nor closes it |
| `listen` | — | `{ port?, host? }`; tracked with `useReady` (only when the feature owns the server), so startup failures surface |
| `prefix` | `'/api/v1'` (`DEFAULT_HTTP_PREFIX`) | base path of the v1 API |
| `version` | — | reported by the meta route |
| `guiStorePath` | — | persistence path for the gui-store route |
| `webAssetsDir` | — | serve a static web bundle |
| `openInApps` | — | advertised "open in" applications on the meta route |
| `corsOrigins` | — | CORS allow-list (only when the feature owns the server) |
| `wsHeartbeatMs` | — | WebSocket heartbeat interval |

## What Gets Registered

One `createHttp` mounts four route layers plus WebSocket endpoints:

- **Built-in facade routes** (`useFacadeRoutes`, at `<prefix>`):
  `health`, `features`, `sessions`, `agents`, `prompts`, `model-catalog`,
  `config`, `tools`, `shutdown`, `connections` — the core session/agent API.
- **Feature facade routes** (`useFeatureFacadeRoutes`, at `<prefix>`): one
  route group per product feature — `sessionTitle`, `sessionExport`,
  `status`, `goal`, `skill`, `task`, `interaction`, `remote-control`,
  `models-dev`, `plugin`, `mcp`, `compaction`, `btw`, `workspaces`, `fs`,
  `capabilities`, `auth`, `fileHistory`, `files`, `sessionMedia`,
  `transcript`. Each group degrades to an error response when its feature
  is not installed (facades are optional by design).
- **V2 session routes** (`useV2SessionRoutes`, at `/api/v2`,
  `V2_HTTP_PREFIX`).
- **Meta / gui-store / web-assets** routes.
- **WebSocket**: v1 at `<prefix>/ws`, v2 at `/api/v2/ws`, both tracked in
  the `WsRegistryRef` registry; the v1 session broadcaster is exposed as
  `WsV1BroadcasterRef`.

The server itself is exposed as `HttpRef` (`route`, `upgrade`, `listen`,
`close`, `origin`) — other features (ACP, remote-control) inject it the
same way route handlers do.

## Add Your Own Routes

Contribute a route from any feature's app unit with `useHttpRoute`:

```ts
import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useHttpRoute } from '@moonshot-ai/harness-core';

export const myRoutes = createFeature('my-routes', {
  app() {
    useHttpRoute({
      id: 'my.hello',
      method: 'GET',
      path: '/api/v1/my/hello',
      handler: async (_request, response) => {
        response.status(200).json({ ok: true });
      },
    });
  },
});
```

Routes are contributions into the `HttpRoutes` collection; the http
feature's route unit registers each with the server and re-registers when
the entry changes, and `useCleanup` withdraws it. `useHttpRoute(route,
priority?)` controls fold order. Handlers are plain
`(request: Request, response: Response) => void | Promise<void>` (express);
the package's own route files share `sendOk` / `sendErr` / `param` /
`ErrorCode` helpers (`src/feature-http/route/`) — `ErrorCode` is exported
from the package root for matching the error envelope.

## Consume Facades in Handlers

Handlers run outside the unit tree, so `useInject` is unavailable. Resolve
facades from the root unit instead:

```ts
import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import {
  agentFacade,
  unitsReady,
  useHttpRoute,
  useRootUnit,
  type TodoFace,
  TodoRef,
} from '@moonshot-ai/harness-core';

export const todoRoutes = createFeature('todo-routes', {
  app() {
    const root = useRootUnit();
    useHttpRoute({
      id: 'todos.list',
      method: 'GET',
      path: '/api/v1/sessions/:session_id/todos',
      handler: async (request, response) => {
        await unitsReady(root); // let mounts/facades settle
        const face: TodoFace | undefined = agentFacade(
          root,
          TodoRef,
          request.params['session_id'] as string,
          MAIN_AGENT_ID,
        );
        if (face === undefined) {
          response.status(503).json({ code: 50301, msg: 'todo feature is not installed' });
          return;
        }
        response.status(200).json({ items: face.items.value });
      },
    });
  },
});
```

The pieces:

- `useRootUnit()` — the app root `UnitNode` (the `RootRef` token).
- `unitsReady(root)` — resolves when the tree's pending mounts settle; call
  it before resolving facades so a just-created session's features are up.
- `sessionFacade(root, Token, sessionId)` /
  `agentFacade(root, Token, sessionId, agentId)` — locate the level unit and
  resolve the token; `undefined` means "not installed or not open" — answer
  with a feature-unavailable error, never crash.
- For routes that must work on **cold** sessions (not currently open), the
  package's route files use `resumeSession(app, sessionId)` /
  `ensureSessionAgent(app, session, agentId)`
  (`src/feature-http/route/resume-session.ts`), which open the session from
  the space and re-create runtimes for every roster agent.

## WebSocket Endpoints

`useWsEndpoint({ http, prefix, registry })` mounts an upgrade endpoint at
`<prefix>/ws` and records it in the shared `WsRegistryRef` registry — that
is how both built-in sockets are implemented; reuse the same helper for
your own channels.

## See Also

- `example/app.ts` mounts `createHttp` with CORS and port env handling.
- [Facades](../reference/facades.md) — the tokens your handlers will resolve.
- [Events](../reference/events.md) — for push channels, `app.on` inside the
  transport feature beats polling facades.
