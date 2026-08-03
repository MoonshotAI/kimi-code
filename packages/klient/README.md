# @moonshot-ai/klient

Contract-driven client SDK for the Rust `kimi-agent` engine (the retired
agent-core-v2 engine has been fully replaced; this SDK is the host-layer
client facade, bound over the rust transport). One facade, one transport —
you create the klient **once**; everything after that is byte-identical:

```ts
import { createKlientFromRust } from '@moonshot-ai/klient/rust';

const klient = createKlientFromRust({ homeDir });

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
rust
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

## Transport

| entry | options | events |
|---|---|---|
| `@moonshot-ai/klient/rust` | `{ homeDir?, configPath? }` — spawns the rust-loop engine over stdio | engine `host/event` stream, scope-matched |

The rust transport builds a `KlientChannel` over the rust-loop stdio bridge
and assembles host-side services (config / flags / auth / fs / workspaces /
plugins / catalog) locally; engine-backed services resolve to rust-loop RPCs.

Facade conformance coverage lives in this package's tests
(`test/contract.test.ts`, `test/facade.test.ts`, and the per-surface
`test/rust-*.test.ts` suites against the rust transport).

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

`examples/smoke.ts` drives the rust engine (spawned over stdio) and asserts
the `global` facade end-to-end — no server needed. `examples/basic.ts` is a
shorter narrated tour; `examples/context-usage.ts` traces context-size
readings through a real prompt (requires `KIMI_EXAMPLE_MODEL` +
`KIMI_EXAMPLE_API_KEY`).
