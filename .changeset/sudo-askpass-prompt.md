---
"@moonshot-ai/kimi-code": minor
---

Add a built-in secure sudo password prompt: when a Bash command invokes sudo, a local masked dialog in the TUI and the web UI passes the password to sudo through a per-session askpass helper — the model never sees it. Enabled by default on macOS and Linux; disable with `[sudo_askpass] enabled = false` in `config.toml`.
