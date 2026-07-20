---
"@moonshot-ai/kimi-code": patch
---

Run web servers foreground-only end to end: the /web slash command now always starts a new server, and the `kimi web kill` / `kimi web ps` subcommands are removed — foreground servers stop with Ctrl+C. `kimi server kill` remains as a deprecated fallback that only stops servers started by a version before 0.28.0.
