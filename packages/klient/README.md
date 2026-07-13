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
