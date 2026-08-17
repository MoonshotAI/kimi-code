---
"@moonshot-ai/kimi-code-sdk": minor
---

Daemon file references no longer persist a materialization path: the daemon-file URL builder takes only a file id, and the parsed reference no longer carries a `path` field. The display path is derived from the session media store at read time, so a session fork or home relocation can no longer stale a persisted reference. Urls with a legacy `?path=` query still parse.
