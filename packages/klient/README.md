# @moonshot-ai/klient

Client SDK that reuses `agent-core-v2` service interfaces and fulfills them over
the `/api/v2` HTTP channel. It follows the VS Code model: a channel is bound to
**one Service** (the URL carries the scope + the Service's decorator id) and
method calls are forwarded **verbatim** to the server's reflection dispatcher —
no per-method allowlist, no `resource:action`, no renaming. The shared interface
is the whole contract.

```ts
import { Klient, SessionIndexClient, HttpChannel } from '@moonshot-ai/klient';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';

const client = new Klient({ url: 'http://127.0.0.1:58627' });

// Generic typed proxy: the v2 service token carries both the type and the
// channel name (`String(ISessionIndex)` === 'sessionIndex').
const sessions = await client.core(ISessionIndex).list({});
const meta = await client.session('s1').service(ISessionMetadata).read();

// Explicit, fully-typed implementation of a single interface. The channel is
// bound to the Service's scope URL.
const index: ISessionIndex = new SessionIndexClient(
  new HttpChannel({ baseUrl: 'http://127.0.0.1:58627/api/v2/sessionIndex' }),
);
const page = await index.list({ workspaceId: 'w1' });
```

Service interfaces and tokens are imported directly from `agent-core-v2` leaf
subpaths; the channel and proxy live in this package.

## WebSocket transport (calls + events)

`Klient#ws()` returns a lazily-created `WsKlient` over the persistent
`/api/v2/ws` socket: the same scope entries and typed proxies (one socket
multiplexes every `call`), plus `listen(event, handler)` on each scope for the
server's event streams — core `events`, session `interactions` /
`interactions:resolved`, agent `events`:

```ts
const ws = client.ws();
const sub = ws.session('s1').agent('main').listen('events', (event) => {
  console.log('agent event', event);
});
const pending = await ws.session('s1').service(ISessionApprovalService).listPending();
sub.dispose();
ws.close();
```

The socket answers heartbeats, applies per-call timeouts, and reconnects
automatically after an unexpected close (active `listen`s are re-subscribed;
in-flight calls reject). The bearer token rides the
`kimi-code.bearer.<token>` subprotocol, so the transport works unchanged in
browsers.

## Real-server smoke checks

Run the transport smoke against a real server (the model phase is opt-in). It
creates and archives a fixture session, and therefore touches the selected
workspace's persisted metadata:

```sh
KIMI_SERVER_URL=http://127.0.0.1:58627 \
KIMI_SERVER_TOKEN=YOUR_SERVER_TOKEN \
pnpm smoke

KIMI_SMOKE_MODEL=YOUR_MODEL pnpm smoke
```

The history smoke checks persisted sessions before warming one, including the
cold-session regression where an indexed session is unavailable through the v2
session scope. It sends no explicit mutation request. When `KIMI_SMOKE_MARKER`
is set, the v1 message read resumes the session and may persist server-side
legacy metadata migrations:

```sh
KIMI_SERVER_URL=http://127.0.0.1:58627 \
KIMI_SERVER_TOKEN=YOUR_SERVER_TOKEN \
KIMI_SMOKE_EXPECT_SESSION_ID=YOUR_SESSION_ID \
KIMI_SMOKE_MARKER=YOUR_MARKER \
KIMI_SMOKE_REQUIRE_HISTORY=1 \
pnpm smoke:history
```

`KIMI_SMOKE_EXPECT_CWD` can select a session by working directory instead of
`KIMI_SMOKE_EXPECT_SESSION_ID`. The transport smoke creates its fixture in the
first registered workspace; set `KIMI_SMOKE_CWD` when a different server-local
folder is required. Omit `KIMI_SERVER_TOKEN` only for a server started with
authentication bypassed.
