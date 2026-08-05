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
  method plus event payload schemas. Schemas are hand-mirrored from the
  agent-core-v2 types (retired engine), frozen locally in
  `src/legacy-types.ts`, and pinned by the compile-time parity assertions in
  `test/contract-parity.ts`; if a schema drifts from the frozen shapes, tsc
  fails here first. `maybe()`/`noResult()` in `src/contract/helpers.ts` encode
  the HTTP wire's `null`-vs-`undefined` semantics — use them for every
  `X | undefined` / `void` result.
- **Transports** (`src/transports/rust`) — the single transport. It builds a
  `KlientChannel` (`src/core/channel.ts`) over the rust-loop stdio bridge and
  assembles host-side services (config / flags / auth / fs / workspaces /
  plugins / catalog) locally; engine-backed services resolve to rust-loop
  RPCs.

The facade only covers the surface the rust engine exposes over RPC (engine
scope resolution mirrors the session/agent lifecycle). onWill/hook-style
interception is not wire-exposable (engine hooks are in-process
`OrderedHookSlot`s); file upload and the terminal surface are v1-only and
live in the legacy suites.

## Testing

- Conformance coverage for the facade lives in `test/contract.test.ts` /
  `test/facade.test.ts` (mocked channel) and the per-surface
  `test/rust-*.test.ts` suites against the real rust transport. Add new
  **global** facade coverage there, not ad hoc.
- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live
  suites (moved from server-e2e). They skip unless `KIMI_SERVER_URL` points
  at a running server and **must keep running unchanged**; the v1 surface
  has no stdio equivalent, so these stay live-server-only — do not try to
  run them against the rust transport.
- The retired `scenarios/` scripts were rewritten as suites: image-upload
  and terminal (v1-only surfaces) live in `test/e2e/legacy/`.

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
- `pnpm --filter @moonshot-ai/klient docker:e2e` — docker e2e; the run
  derives its runner name/namespace from the current workspace to avoid
  cross-workspace conflicts.
- `pnpm --filter @moonshot-ai/klient typecheck` / `pnpm smoke` (rust-engine
  smoke over stdio; see `examples/smoke.ts`).
