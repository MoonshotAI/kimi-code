# Serve HTTP

The HTTP transport is itself a feature: `createHttp` mounts a server at the
app level, registers the built-in route layers, and lets any other feature
contribute routes and WebSocket endpoints through the same mechanism. This
guide covers mounting it and adding your own routes.

## Mount the Transport

```ts
import { createApp, createHttp } from '@moonshot-ai/harness-core';

const app = createApp();
await app.features.add(
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
| `server` | created via `createHttpServer` | bring your own `Http` — then the feature neither calls `listen` nor closes it |
| `listen` | — | `{ port?, host? }`; tracked with `useReady` (only when the feature owns the server), so startup failures surface |
| `prefix` | `'/api/v1'` (`DEFAULT_HTTP_PREFIX`) | base path of the v1 API |
| `version` | — | reported by the meta route |
| `guiStorePath` | — | persistence path for the gui-store route |
| `webAssetsDir` | — | serve a static web bundle |
| `openInApps` | — | advertised "open in" applications on the meta route |
| `corsOrigins` | — | CORS allow-list (only when the feature owns the server) |
| `wsHeartbeatMs` | — | WebSocket heartbeat interval |
| `authTokenService` | created from `HOME` | custom credential service (`isValid(candidate)`; `getToken()` is optional) |
| `disableAuth` | `false` | disable REST and WebSocket checks without disabling token-service creation |
| `HOME` | `~/.kimi-code` | home of the persistent `server.token` |
| `PASSWORD` | — | bcrypt-hashed password credential |
| `rpcToken` | — | additional timing-safe Bearer credential |
| `ALLOWED_HOSTS` | — | extra exact or leading-dot Host allow-list entries |
| `DISABLE_HOST_CHECK` | `false` | disable Host validation |
| `bindClass` | `'public'` for wildcard binds | optional `'lan'/'public'` override for wildcard addresses only |
| `PLUGIN_MARKETPLACE_URL` | built-in catalog URL | source served by the plugin marketplace route |

`createHttp` never reads the process environment — every value above is
explicit. `createDefaultHttp` (`src/presets/http.ts`) is the composition
point that maps environment variables onto them: `KIMI_CODE_HOME` → `HOME`,
`KIMI_CODE_PASSWORD` → `PASSWORD`, `KIMI_CODE_ALLOWED_HOSTS` → `ALLOWED_HOSTS`
(merged with the explicit list), `KIMI_CODE_DISABLE_HOST_CHECK` →
`DISABLE_HOST_CHECK`, `KIMI_CODE_PLUGIN_MARKETPLACE_URL` →
`PLUGIN_MARKETPLACE_URL`. Explicitly passed options always win. It creates
the app through `src/presets/base.ts` (`createDefaultApp`), mounts the HTTP
feature plus the remote-control feature, and returns the assembled app.

## Bearer Auth

By default, `listen` creates `<HOME>/server.token` before binding and enables
authentication. The file is written atomically with mode `0600` and reused on
subsequent starts. `rotateServerToken(homeDir)` rotates it atomically; the next
credential check rereads the file, so the old token stops working without a
restart. `PASSWORD` adds a bcrypt-hashed password credential, and
`rpcToken` adds a separate timing-safe credential.

```ts
await app.features.add(
  createHttp({
    HOME: home,
    rpcToken,
    listen: { port: 8787, host: '127.0.0.1' },
  }),
);
```

A custom `authTokenService` replaces the default persistent/password service;
`rpcToken` still applies. Its `getToken()` method is optional, but Remote Control
needs it. After `listen`, read it through `server.authTokenService?.getToken?.()`
so rotation is observed rather than captured once.

Protected API routes require `Authorization: Bearer <token>`. Missing or invalid
credentials return HTTP 401 with error code `40101`. `OPTIONS`, the v1 health
check, and non-API static assets remain public. Both WebSocket endpoints accept
the same Authorization header; `/api/v1/ws` also accepts the
`kimi-code.bearer.<token>` subprotocol.

`disableAuth: true` disables checks but still initializes the default service.
The `/meta` route reports this as `dangerous_bypass_auth: true`.

When bringing your own server, configure security on that server instead of
passing the same options again to `createHttp`:

```ts
const server = createHttpServer({ HOME: home, rpcToken, corsOrigins: ['app://renderer'] });
await server.listen();
await app.features.add(createHttp({ server }));
```

## Transport Protections

- HTTP validates Host before CORS and auth; invalid Host returns HTTP 403 with
  `40301`. Hosts allowed via `ALLOWED_HOSTS` (or `KIMI_CODE_ALLOWED_HOSTS`
  through `createDefaultHttp`) pass.
- WebSocket upgrades check Host, then Origin, then credentials. Host or Origin
  rejection returns raw HTTP 403; credential rejection returns raw HTTP 401.
- Non-loopback REST auth allows 10 failures per source IP in 60 seconds, then
  bans for 60 seconds. The next request returns HTTP 429 with `42901`, even with
  a valid credential. WS upgrades are not rate-limited.
- Non-loopback HTTP responses carry `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and the kap-compatible CSP. Loopback responses
  omit them. The built-in plain-HTTP server does not emit HSTS.

## What Gets Registered

One `createHttp` mounts four route layers plus WebSocket endpoints:

- **Built-in facade routes** (`useFacadeRoutes`, at `<prefix>`):
  `health`, `features`, `sessions`, `agents`, `prompts`, `model-catalog`,
  `config`, `tools`, `shutdown`, `connections` — the core session/agent API.
- **Feature facade routes** (`useFeatureFacadeRoutes`, at `<prefix>`): one
  route group per product feature — `sessionTitle`, `sessionExport`,
  `status`, `skill`, `task`, `interaction`, `remote-control`,
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
`close`, `origin`, `dangerousBypassAuth`, `authTokenService`) — other features
(ACP, remote-control) inject it the same way route handlers do.

## Add Your Own Routes

Contribute a route from any feature's app unit with `useHttpRoute`:

```ts
import { createFeature } from '#/app/index';
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
import { createFeature } from '#/app/index';
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

- `example/app.ts` mounts `createHttp` with its persistent-token home, CORS, and port env handling; `example/index.ts` prints a token-bearing access URL.
- [Facades](../reference/facades.md) — the tokens your handlers will resolve.
- [Events](../reference/events.md) — for push channels, `app.on` inside the
  transport feature beats polling facades.
