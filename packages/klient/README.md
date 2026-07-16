# @moonshot-ai/klient

Contract-driven client SDK for the agent-core-v2 engine. One facade, three
transports — you pick the transport **once** at creation; everything after
that is byte-identical:

```ts
import { createKlient } from '@moonshot-ai/klient/http';   // or '/ipc', '/memory'

const klient = createKlient({ url: 'http://127.0.0.1:58627', token });

const env = await klient.global.env();
const sessions = await klient.global.sessions.list({ limit: 20 });

const session = await klient.global.sessions.create({ workDir: process.cwd() });
const agent = klient.session(session.id).agent('main');
agent.events.on('assistant.delta', (e) => process.stdout.write(e.delta));
agent.events.on('prompt.completed', () => console.log('\ndone'));
await agent.prompt({ input: [{ type: 'text', text: 'Say OK.' }] });

await klient.close();
```

## Architecture

```
facade (klient.global.*, klient.session(id).*, session.agent(id).*, *.events.*)
   ↓ single-object params, zod-validated
contract (procedure schemas, shared by all transports)
   ↓
KlientChannel { call, listen }   ← the only transport SPI
   ↓
http │ ipc │ memory
```

- **Facade** — aggregated methods, no engine service tokens, no
  `onDid*`/`onWill*` event names. There is no escape hatch to raw services:
  the facade is the public contract.
  - `klient.global.*` — `sessions.*` (incl. `create`), `workspaces.*`,
    `config.*`, `providers.*`, `models.*`, `catalog.*`, `auth.*`, `flags.*`,
    `plugins.*`, `hostFs.*`, `env()`.
  - `klient.session(id).*` — `get/setTitle/update/status/close/archive/
    restore/fork/createChild`, `approvals.*`, `questions.*`,
    `interactions.*`, `agents()`.
  - `session.agent(id).*` — `prompt/steer/cancel/runShellCommand/
    cancelShellCommand/getModel/setModel/setPermission/getUsage/getContext/
    getPlan*/getTasks*/stopTask/getTaskOutput`.
- **Contract** — every method has a zod input tuple + output schema, validated
  on the client before send / after receive (default on; `validate: false` to
  disable). Validation is sub-µs for typical payloads — cheaper than the JSON
  serialization the wire already pays.
- **Events** — `klient.events.on(...)` for the global bus
  (`config.changed`, `models.changed`, `session.archived`, …),
  `session(id).events.on('metadata.changed' | 'interactions.changed' |
  'interactions.resolved')`, and `agent(id).events.on('turn.started' |
  'assistant.delta' | 'tool.call.started' | 'prompt.completed' | …)`.
  Underlying subscriptions are shared and ref-counted; payloads are
  validated; bad payloads drop to `events.onError`.

## Transports

| entry | options | events |
|---|---|---|
| `@moonshot-ai/klient/http` | `{ url, token?, fetch?, WebSocketImpl? }` | lazily opened WS, transparent |
| `@moonshot-ai/klient/ipc` | `{ socketPath, token? }` | same socket |
| `@moonshot-ai/klient/memory` | `{ scope }` (a bootstrapped engine app scope) | direct emitter/bus subscription |

`ipc` and `memory` share one in-process dispatcher, so they behave identically
by construction; `memory` additionally JSON round-trips every value so results
match the networked transports byte-for-byte. The IPC host ships with the
transport: `serveKlientIpc({ scope, socketPath })`.

The same conformance suite runs against all three transports in this
package's tests (`test/helpers/conformance.ts` — one test file per transport;
the http leg boots an in-process kap-server).

This package also hosts the e2e suites (the retired `server-e2e` package was
folded in here):

- `test/e2e/dual/` — session/agent suites that run the **exact same body**
  against an in-memory engine and an in-process kap-server
  (`test/helpers/dual.ts`). Model-requiring suites skip unless
  `KIMI_E2E_MODEL` + `KIMI_E2E_API_KEY` (optional `KIMI_E2E_BASE_URL`,
  `KIMI_E2E_PROTOCOL`) are set; the model is seeded into each backend's temp
  home through the facade itself.
- `test/e2e/v2/` — `/api/v2` wire tests booting kap-server in-process.
- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live suites
  and their client harness (skip unless `KIMI_SERVER_URL` is set; the v1
  surface has no in-memory equivalent, so these stay http-only).

The docker e2e runner (`pnpm docker:e2e`) runs this whole vitest suite inside
a container against a container-local server. See `AGENTS.md` for the testing
rules.

## Scope

The facade covers the global (app), session, and agent surfaces shown above.
What it deliberately leaves out (for now): onWill/hook-style interception
(engine hooks are in-process `OrderedHookSlot`s and not wire-exposable), file
upload (v1 multipart REST only), and the terminal surface (v1 REST + WS
only).

## Real-server smoke check

```sh
KIMI_SERVER_URL=http://127.0.0.1:58627 \
KIMI_SERVER_TOKEN=YOUR_SERVER_TOKEN \
pnpm -C packages/klient smoke
```

Omit `KIMI_SERVER_TOKEN` only for a server started with authentication
bypassed. `examples/basic.ts` is a shorter narrated tour.
