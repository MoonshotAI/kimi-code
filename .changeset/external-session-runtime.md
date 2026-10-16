---
"@moonshot-ai/kimi-code": minor
---

Add external session observability: CLI runs now record their source in session metadata (`KIMI_CODE_INVOKED_BY` for `kimi -p`, else `cli-print`/`cli`), the server lists sessions running in other local processes at `GET /api/v1/external-sessions`, and resuming or deleting a session while it is active in another local process now fails with a busy error instead of writing to it concurrently.
