---
"@moonshot-ai/kimi-code": patch
---

Bound the transcript in `!`-heavy sessions: each shell command now groups as its own trimmable turn instead of piling into an untrimmable tail turn, and a finished command's stored stdout/stderr is capped to the last 64 Ki characters per stream.

What you lose by default: for a finished `!` command whose stdout or stderr exceeds the cap, the earlier output is no longer stored, so `Ctrl-O` cannot reveal it and export/copy only see the kept tail. The first line reports how many characters were dropped. Running output was already capped mid-stream; this extends the bound to the finished copies.

Escape hatch: set `KIMI_CODE_TUI_MAX_STORED_CHARS=0` to keep the full output as before, or set it to any positive integer to choose a different cap. It uses the same env parsing as the other `KIMI_CODE_TUI_*` knobs, so an unset, empty, negative or non-integer value falls back to the 64 Ki default.
