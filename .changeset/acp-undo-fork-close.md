---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

ACP: add the `/undo [count]` built-in slash command (drives the SDK's `undoHistory`, refused while a turn is running) and two `kimi/*` extension methods: `kimi/session/fork` (fork a session into an ephemeral, promptable copy for btw-style side conversations) and `kimi/session/close` (close a session, with `archive: true` to also archive the on-disk directory). The SDK gains `KimiHarness.archiveSession` and an `rpc.archiveSession` passthrough for the archive path.
