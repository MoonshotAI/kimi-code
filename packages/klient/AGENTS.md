# klient Agent Guide

Package-local rules for `packages/klient`.

## Architecture

The package is layered; keep the layers strict when changing code:

- **Facade** (`src/core/facade/`, `src/core/klient.ts`) — the only public API:
  aggregated `global.*` / `session(id).*` / `session(id).agent(id).*` methods
  and their `events.*` hubs. No engine service tokens, no `onDid*`/`onWill*`
  names, and **no escape hatch to raw services** — do not reintroduce a
  service locator (`core()`/`service()`/`makeProxy`).
- **Contract** (`src/contract/`) — zod input/output schemas for every wire
  method plus event payload schemas. Schemas are hand-mirrored from
  agent-core-v2 types and pinned by the compile-time parity assertions in
  `test/contract-parity.ts`; when the engine types change, tsc fails here
  first. `maybe()`/`noResult()` in `src/contract/helpers.ts` encode the HTTP
  wire's `null`-vs-`undefined` semantics — use them for every
  `X | undefined` / `void` result.
- **Transports** (`src/transports/{ipc,memory}`) — each implements the
  `KlientChannel` SPI (`src/core/channel.ts`) and nothing else. ipc frames
  the same dispatcher traffic as NDJSON over a unix socket and shares the
  in-process dispatcher with memory; memory JSON round-trips every value so
  both transports return byte-identical data.

The facade only covers services that behave identically on both transports
(the in-process dispatcher mirrors the server's scope resolution, including
`main`-agent materialization via `ensureMainAgent`). onWill/hook-style
interception is not wire-exposable
(engine hooks are in-process `OrderedHookSlot`s); file upload and the
terminal surface are v1-only and live in the legacy suites.

## Testing

- One shared conformance suite (`test/helpers/conformance.ts`) runs unchanged
  against every transport — one test file per transport under `test/`. Add
  new **global** facade coverage there, not per-transport.
- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live
  suites (moved from server-e2e). They skip unless `KIMI_SERVER_URL` points
  at a running server and **must keep running unchanged**; the v1 surface
  has no in-memory equivalent, so these stay live-server-only — do not try
  to run them against the in-process transports. Exception: the
  dual-instance / session-ownership suites (`legacy/dual-instance.test.ts`,
  `legacy/session-ownership.test.ts`) boot their own kap-server instances
  via the helpers below and run without `KIMI_SERVER_URL`.
- The retired `scenarios/` scripts were rewritten as suites: image-upload
  and terminal (v1-only surfaces) live in `test/e2e/legacy/`.

## Dual-instance helpers

Multi-server e2e cases boot two `kap-server` instances on ONE shared home via
`test/e2e/harness/testing/` (re-exported from `test/e2e/harness/index.js`).
Pick the helper by what the case needs:

- **`startServerPair(options?)`** — default. Two in-process instances on one
  shared `mkdtemp` home (or caller-provided `home`), each with `port: 0`,
  `logLevel: 'silent'`, and `disableAuth: true` by default. Returns
  `{ a, b, home, cwd, urlA, urlB, baseUrl(server), connectClient(server), dispose() }`;
  `connectClient` returns an authed `HttpClient` (bearer from
  `server.authTokenService.getToken()` when `disableAuth: false`). `cwd` is
  the shared workspace cwd — pass it as `metadata.cwd` in `createSession` on
  both instances ("same cwd" is session-level, never a server flag).
  `dispose()` closes both instances (best-effort), restores env, and removes
  the home only if the helper created it.
- **`spawnServerProcess(options?)` / `spawnServerProcessPair(options?)`** —
  subprocess mode for signal-sensitive cases (SIGSTOP / SIGCONT / SIGKILL,
  kill -9 lease takeover) that need real, distinct pids. Each child is
  `node --import <tsx loader> --import build/register-raw-text-loader.mjs
  test/e2e/harness/testing/serverProcessMain.ts` with
  `TSX_TSCONFIG_PATH=tsconfig.dev.json` (the dev tsconfig's `include` covers
  every package's `src`, which tsx's per-file tsconfig mapping needs for
  `experimentalDecorators` in the agent-core graph). Do NOT switch the
  incantation to the tsx CLI: it is a hub/spoke wrapper that forks the server
  as a grandchild, so `child.pid` — and every signal sent to it — would miss
  the actual server. The helper asserts the pid the child reports in its
  `{type:'ready'}` stdout line equals `child.pid` to catch exactly this.
  `stop()` is SIGTERM + await exit, escalating to SIGKILL after ~10s.

Hard rules:

- Always `port: 0`. A fixed busy port silently walks to `port + 1`, which
  breaks registry/port assertions and cross-test isolation.
- One pair per test file/worker; never share a `RunningServer` or
  `SpawnedServer` across files — vitest runs files in parallel workers.
- Readiness when NOT using these helpers: poll `GET /api/v1/healthz`
  (auth-exempt) until 200 — not `/api/v1/meta` (token-gated).
- The helpers import `@moonshot-ai/kap-server` lazily at call time so the
  harness barrel stays loadable under plain `tsx` without the raw-text
  loader; keep that pattern when extending them.

## Observability (inherited from server-e2e)

- Keep observability inside each e2e case; every live case prints structured,
  case-scoped details (requests, envelopes, WS handshakes, terminal frames,
  error envelopes) through the shared logger in `test/e2e/legacy/log.ts`,
  not ad hoc `console.log`.
- Logs must stay visible for passing Vitest cases — write through stdout.
- When adding or changing an e2e case, update its observability at the same
  time; do not add a scenario solely to print data an existing case should
  already expose.

## Command reference

- `pnpm --filter @moonshot-ai/klient test` — all Vitest suites (unit +
  conformance + e2e; live cases skip without their env).
- `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/klient test`
  — include the live legacy cases against a running server.
- `pnpm --filter @moonshot-ai/klient exec vitest run test/e2e/legacy/dual-instance.test.ts`
  — dual-instance helper self-tests (boot their own in-process + subprocess
  servers; no external server needed). Same for
  `test/e2e/legacy/session-ownership.test.ts`.
- `pnpm --filter @moonshot-ai/klient docker:e2e` — docker e2e; the run
  derives its runner name/namespace from the current workspace to avoid
  cross-workspace conflicts.
- `pnpm --filter @moonshot-ai/klient typecheck` / `pnpm smoke` (in-process
  smoke over the memory transport; see `examples/smoke.ts`).
- `pnpm --filter @moonshot-ai/klient smoke:boundary` — ModelRequester boundary
  probe: pings every model configured in the real `~/.kimi-code/config.toml`
  through the in-process engine, then drives deterministic failure modes
  against a local stub to show which errors the ChatProvider layer wraps and
  which the requester owns (see `examples/model-requester-boundary.ts`).
- `pnpm --filter @moonshot-ai/klient smoke:select-tools` — select_tools
  (progressive tool disclosure) probe for kimi-type providers: stub-verifies
  the kimi-only wire encoding of dynamic tool declarations, then runs a live
  two-step select→use flow per real kimi model (see
  `examples/kimi-select-tools.ts`).
