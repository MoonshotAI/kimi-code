# server-e2e Agent Guide

This file contains package-local rules for `packages/server-e2e`.

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
- Run type checking for this package: `pnpm --filter @moonshot-ai/server-e2e typecheck`.
