---
"@moonshot-ai/kimi-code": patch
---

Fix glob file searches so all patterns continue to respect ignore files. A positive ripgrep `--glob` always overrides ignore logic, so any non-broad user pattern (e.g. `*.ts`, `dist/**/*.js`) could re-include files excluded by `.gitignore`. The pattern is now filtered in-process after `rg --files` enumerates non-ignored files.
