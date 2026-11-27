---
"@moonshot-ai/acp-server": patch
---

`session/list` matches the requested `cwd` against session directories as directories, so separators, Windows letter case and a trailing separator no longer hide sessions.
