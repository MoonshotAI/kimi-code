# @moonshot-ai/klient

Contract-driven client SDK for the agent-core-v2 engine. One facade, two
transports — you pick the transport **once** at creation; everything after
that is byte-identical:

```ts
import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { createKlient } from '@moonshot-ai/klient/memory';   // or '/ipc'

const { app } = bootstrap({ homeDir }, [
  ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
]);
const klient = createKlient({ scope: app });

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
ipc │ memory
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
  (`config.changed`, `kosong.models.changed`, `session.archived`, …),
  `session(id).events.on('metadata.changed' | 'interactions.changed' |
  'interactions.resolved')`, and `agent(id).events.on('turn.started' |
  'assistant.delta' | 'tool.call.started' | 'prompt.completed' | …)`.
  Underlying subscriptions are shared and ref-counted; payloads are
  validated; bad payloads drop to `events.onError`.

## Transports

| entry | options | events |
|---|---|---|
| `@moonshot-ai/klient/ipc` | `{ socketPath, token? }` | same socket |
| `@moonshot-ai/klient/memory` | `{ scope }` (a bootstrapped engine app scope) | direct emitter/bus subscription |

`ipc` and `memory` share one in-process dispatcher, so they behave identically
by construction; `memory` additionally JSON round-trips every value so results
cross the same JSON boundary a socket transport would impose. The IPC host
ships with the transport: `serveKlientIpc({ scope, socketPath })`.

The same conformance suite runs against both transports in this
package's tests (`test/helpers/conformance.ts` — one test file per transport).

This package also hosts the e2e suites (the retired `server-e2e` package was
folded in here):

- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live suites
  and their client harness (skip unless `KIMI_SERVER_URL` is set; the v1
  surface has no in-memory equivalent, so these stay live-server-only).

The docker e2e runner (`pnpm docker:e2e`) runs this whole vitest suite inside
a container against a container-local server. See `AGENTS.md` for the testing
rules.

## Scope

The facade covers the global (app), session, and agent surfaces shown above.
What it deliberately leaves out (for now): onWill/hook-style interception
(engine hooks are in-process `OrderedHookSlot`s and not wire-exposable), file
upload (v1 multipart REST only), and the terminal surface (v1 REST + WS
only).

## Smoke check

```sh
pnpm -C packages/klient smoke
```

`examples/smoke.ts` boots an in-process engine (memory transport) and asserts
the `global` facade end-to-end — no server needed. `examples/basic.ts` is a
shorter narrated tour; `examples/context-usage.ts` traces context-size
readings through a real prompt (requires `KIMI_EXAMPLE_MODEL` +
`KIMI_EXAMPLE_API_KEY`).
