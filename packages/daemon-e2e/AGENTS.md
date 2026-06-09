# daemon-e2e Agent Guide

This file contains package-local rules for `packages/daemon-e2e`.

## Testing Principle

- Keep observability inside each daemon-e2e case. Do not add a separate "observable" test or scenario as a substitute for making the existing cases explain what they drove and what the daemon returned.
- Every live daemon case should print structured, case-scoped details for the flow it exercises: key REST requests, response envelopes or unwrapped responses, WebSocket handshakes / acks / replay summaries, prompt terminal frames, and error envelopes.
- Prefer a shared logging helper over ad hoc `console.log` formatting. Logs must be visible for passing Vitest cases, so write through stdout when Vitest would otherwise capture console output.
- Keep logs factual and diagnostic. Print enough detail to debug the wire contract, but avoid unrelated narration.

## Workflow

- When adding or changing a daemon-e2e case, update that case's observability at the same time.
- Do not add a new scenario solely to print data that an existing scenario or Vitest case should already expose.
- Run the relevant daemon-e2e tests against `DAEMON_URL=http://127.0.0.1:7878` when a daemon is available, and confirm the output includes the case-scoped diagnostic blocks.
