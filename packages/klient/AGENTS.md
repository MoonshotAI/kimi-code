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
(engine hooks are in-process `OrderedHookSlot`s); the terminal surface is
not on the facade. File upload IS on the facade
(`global.files`): bytes cross the wire base64-encoded and the dispatcher
adapts the engine's `IFileService` streams in both directions.

## Testing

- One shared conformance suite (`test/helpers/conformance.ts`) runs unchanged
  against every transport — one test file per transport under `test/`. Add
  new **global** facade coverage there, not per-transport.

## Command reference

- `pnpm --filter @moonshot-ai/klient test` — all Vitest suites (unit +
  conformance + e2e).
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
