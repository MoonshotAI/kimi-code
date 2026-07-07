# @moonshot-ai/server-e2e

Wire-level test client for the kimi-code server (HTTP + WS). This package is
**private** — it ships scenario scripts that double as smoke tests and a small
typed `DaemonClient` you can reuse in vitest e2e files.

## When to use this

- You want to drive a real, running server process from a Node script and
  observe HTTP + WS behavior end to end.
- You're writing a vitest e2e that covers server REST + WS lifecycle as a
  whole — not a single in-process unit (those belong in `packages/server/test/`).
- You need a reference for the wire shape of approval / question / events.

## When NOT to use this

- You're testing the WS gateway in isolation — keep using
  `packages/server/test/ws-*.e2e.test.ts` (in-process `startServer` boots are
  faster and assert on the server's internal services directly).
- You want a typed in-process facade over the server for user-facing code —
  use `@moonshot-ai/node-sdk` instead (`KimiHarness`, `Session`).

## Quick start

```ts
import { DaemonClient } from '@moonshot-ai/server-e2e';

const client = new DaemonClient(); // http://127.0.0.1:58627 by default

const session = await client.createSession({ metadata: { cwd: process.cwd() } });
await client.connect();              // server_hello + client_hello ack
await client.subscribe(session.id);

client.onApprovalRequested(() => ({ decision: 'approved' }));

const { prompt_id, finalFrame } = await client.submitAndWait(session.id, {
  content: [{ type: 'text', text: 'Echo hello' }],
});

await client.close();
await client.archiveSession(session.id);
```

> The exported facade is still spelled `DaemonClient` to keep the diff small;
> conceptually it is the **server** client.

## Scripts

```sh
pnpm --filter @moonshot-ai/server-e2e typecheck
pnpm --filter @moonshot-ai/server-e2e test            # vitest self-tests
pnpm --filter @moonshot-ai/server-e2e test:scenarios  # run every scenarios/*.ts
pnpm --filter @moonshot-ai/server-e2e docker:e2e      # run server + scenarios in docker
```

Both `test` and `test:scenarios` require a running server (set `KIMI_SERVER_URL`
to override the default `http://127.0.0.1:58627`). The vitest suite skips its
live-dependent cases when no server is reachable so CI stays green. Scenarios
are run via `tsx` because they execute TypeScript directly.

Both commands write a browser-readable report to
`packages/server-e2e/reports/latest/index.html` (override with
`KIMI_SERVER_E2E_REPORT_DIR`). The report groups events by case and shows a compact
timeline of case logs, HTTP request / response envelopes, WebSocket frames, and
test results. JSON payloads are kept in collapsed detail blocks so the terminal
can stay concise while the full wire trace remains available.

`docker:e2e` builds `kimi-server:dev` from the root `Dockerfile`, layers
`packages/server-e2e/Dockerfile` on top, then runs a one-shot Docker container.
The container starts the server on container-local `127.0.0.1:58627` and runs
`pnpm test:scenarios` in the same container. The launcher intentionally does
not pass `-p` / `--publish`, so it does not expose a server port on the host and
can coexist with the `docker-compose.yml` server that publishes host port 58627.
Reports are written under
`~/.kimi-code-server-dev/server-e2e-reports/docker/<run-id>/latest/index.html`;
the server log is written beside them as `server.log`.

The Docker workflow uses an isolated KIMI home at
`~/.kimi-code-server-dev/docker-e2e/<run-id>/kimi-code-home` to avoid sharing
server locks with Compose. `<run-id>` is deterministic by default:
`<repo-basename>-<cksum-of-repo-path>`, so different worktrees do not collide.
On first run it seeds `config.toml` and `credentials/` from
`~/.kimi-code-server-dev/kimi-home/kimi-code-home` when those files exist.
Override the namespace with `KIMI_SERVER_E2E_RUN_ID`, or override paths with
`KIMI_SERVER_E2E_STATE_ROOT`, `KIMI_SERVER_E2E_KIMI_HOME_HOST`,
`KIMI_SERVER_E2E_SEED_KIMI_HOME_HOST`, or `KIMI_SERVER_E2E_REPORT_DIR_HOST`.

## Public API summary

| Symbol | Purpose |
|---|---|
| `DaemonClient` | Main facade — HTTP + WS, handshake plumbing, reverse-RPC handlers. |
| `HttpClient` | REST helpers only (no WS). Useful when you don't need event observation. |
| `WsClient` | Raw WS wrapper — queue, waiters, ack correlation. |
| `EnvelopeError` | Thrown by `unwrap()` / HTTP helpers when `envelope.code !== 0`. |
| `fetchWithReport` / `writeHtmlReport` | Capture direct fetch calls and render the JSONL trace as a single HTML report. |
| `installReverseRpcHandler` | Uniform helper powering `onApprovalRequested` / `onQuestionAsked`. |
| `waitForFrame` / `waitForSessionStatus` | Standalone wait helpers reused by scenarios. |

See `scenarios/README.md` for the executable script catalog and conventions.

## Scope notes

- **No in-process server bootstrap** — point at an already-running server.
  An in-process `startServer(port:0)` helper is intentionally out of scope.
- **No auto-discovery** — the WS endpoint is hard-coded to `${apiPrefix}/ws`.
  Override via `apiPrefix` only.
- **Not published** — `private: true`. Internal tooling only.
