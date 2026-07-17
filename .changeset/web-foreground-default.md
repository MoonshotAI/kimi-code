---
"@moonshot-ai/kimi-code": minor
---

**Breaking**: `kimi web` and the TUI `/web` command now run the server in the foreground by default instead of backgrounding a daemon — the command stays attached to the terminal until Ctrl+C instead of returning immediately. Pass `--background` in scripts or launchers to keep the previous background behavior; `kimi server run` is unchanged.
