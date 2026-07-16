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
- **Transports** (`src/transports/{http,ipc,memory}`) — each implements the
  `KlientChannel` SPI (`src/core/channel.ts`) and nothing else. http carries
  events over a lazily opened WS; ipc reuses the WS frame shapes over a unix
  socket and shares the in-process dispatcher with memory; memory JSON
  round-trips every value so all three transports return byte-identical data.

The facade only covers services kap-server exposes over `/api/v2` **and** that
behave identically on all three transports (the in-process dispatcher mirrors
the server's scope resolution, including `main`-agent materialization via
`ensureMainAgent`). onWill/hook-style interception is not wire-exposable
(engine hooks are in-process `OrderedHookSlot`s); file upload and the
terminal surface are v1-only and live in the legacy suites.

## Testing

- One shared conformance suite (`test/helpers/conformance.ts`) runs unchanged
  against every transport — one test file per transport under `test/`; the
  http leg boots an in-process kap-server. Add new **global** facade coverage
  there, not per-transport.
- Session/agent coverage lives in `test/e2e/dual/` (`test/helpers/dual.ts`):
  every suite runs the exact same body against an in-memory engine AND an
  in-process kap-server. Model-requiring suites declare
  `{ requiresModel: true }` and skip unless `KIMI_E2E_MODEL` +
  `KIMI_E2E_API_KEY` (optional `KIMI_E2E_BASE_URL` / `KIMI_E2E_PROTOCOL`)
  are set; the model is seeded into each backend's temp home via
  `klient.global.models.set` and agents bind it with
  `agent.setModel(DUAL_MODEL_ID)`.
- `test/e2e/v2/` — `/api/v2` wire tests booting kap-server in-process.
- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live
  suites (moved from server-e2e). They skip unless `KIMI_SERVER_URL` points
  at a running server and **must keep running unchanged**; the v1 surface
  has no in-memory equivalent, so these stay http-only — do not try to
  dual-run them.
- The retired `scenarios/` scripts were rewritten as suites: prompt /
  approval / workspace / catalog / children / pending flows live in
  `test/e2e/dual/`; image-upload and terminal (v1-only surfaces) live in
  `test/e2e/legacy/`; refresh-replay was dropped as redundant with the
  legacy test of the same name.

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
  conformance + e2e; live and model cases skip without their env).
- `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/klient test`
  — include the live legacy/v2 cases against a running server.
- `KIMI_E2E_MODEL=... KIMI_E2E_API_KEY=... [KIMI_E2E_BASE_URL=...] pnpm --filter @moonshot-ai/klient exec vitest run test/e2e/dual`
  — run the model-requiring dual suites against both backends.
- `pnpm --filter @moonshot-ai/klient docker:e2e` — docker e2e; the run
  derives its runner name/namespace from the current workspace to avoid
  cross-workspace conflicts.
- `pnpm --filter @moonshot-ai/klient typecheck` / `pnpm smoke` (real-server
  smoke; see `examples/smoke.ts`).
