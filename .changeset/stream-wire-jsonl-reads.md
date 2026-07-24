---
"@moonshot-ai/kimi-code": patch
---

Read session wire logs line-by-line instead of loading whole files into memory, cutting peak memory when serving session snapshots, history transcripts, and debug exports of long sessions.
