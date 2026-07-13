# server-e2e Agent Guide

This file contains package-local rules for `packages/server-e2e`.

## Package layout

This package ships two clients:

- **Legacy `/api/v1` client** — `DaemonClient` (`src/client.ts`), `HttpClient`
  (`src/http.ts`), `WsClient` (`src/ws.ts`) and the helpers under `src/`
  (`wait.ts`, `reverse-rpc.ts`, `report.ts`, `envelope.ts`). This is the
  original wire-level test client; the existing `test/*.test.ts` cases and
  `scenarios/*.ts` scripts are built on it and **must keep running unchanged**.
  Do not break or rewrite those tests when extending the package.
- **server-v2 SDK** — `ServerClient` under `src/v2/`. A lark-style typed client
  for the `server-v2` `/api/v2` RPC + WS surface. `src/v2/resources/manifest.ts`
  mirrors `server-v2/src/transport/actionMap.ts`; `test/v2/actionMap.test.ts`
  is a drift test that fails when the server surface and the manifest diverge.
  The legacy REST surface is reachable via `ServerClient#v1`.

## Testing Principle

- Keep observability inside each server-e2e case. Do not add a separate "observable" test or scenario as a substitute for making the existing cases explain what they drove and what the server returned.
- Every live server case should print structured, case-scoped details for the flow it exercises: key REST requests, response envelopes or unwrapped responses, WebSocket handshakes / acks / replay summaries, prompt terminal frames, and error envelopes.
- Prefer a shared logging helper over ad hoc `console.log` formatting. Logs must be visible for passing Vitest cases, so write through stdout when Vitest would otherwise capture console output.
- Keep logs factual and diagnostic. Print enough detail to debug the wire contract, but avoid unrelated narration.

## Workflow

- When adding or changing a server-e2e case, update that case's observability at the same time.
- Do not add a new scenario solely to print data that an existing scenario or Vitest case should already expose.
- Run the relevant server-e2e tests against `KIMI_SERVER_URL=http://127.0.0.1:58627` when a server is available, and confirm the output includes the case-scoped diagnostic blocks.
- Run Docker e2e with `pnpm --filter @moonshot-ai/server-e2e docker:e2e`; each run must derive its Docker runner name/namespace from the current workspace to avoid cross-workspace conflicts.

## Command Reference

- Start a local server from the repo root before validating live cases: `pnpm dev:server`.
- Run only the undo helper/live e2e coverage: `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/server-e2e test -- test/client.test.ts -t undoSession`.
- Run the full server client Vitest file: `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/server-e2e test -- test/client.test.ts`.
- Run all server-e2e Vitest tests: `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/server-e2e test`.
- Run all executable scenarios against the local server: `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/server-e2e test:scenarios`.
- Run the server-v2 SDK drift test (no server needed): `pnpm --filter @moonshot-ai/server-e2e exec vitest run test/v2/actionMap.test.ts`.
- Run the server-v2 SDK smoke test (boots server-v2 in-process): `pnpm --filter @moonshot-ai/server-e2e exec vitest run test/v2/smoke.test.ts`.
- Run type checking for this package: `pnpm --filter @moonshot-ai/server-e2e typecheck`.
