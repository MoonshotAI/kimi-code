---
"@moonshot-ai/kimi-code": minor
---

Move foreground Bash commands that hit their timeout to the background instead of killing them, so long-running commands survive the timeout and report back on completion. Set `bash_auto_background_on_timeout = false` under `[background]` in config.toml to restore the kill-on-timeout behavior.
