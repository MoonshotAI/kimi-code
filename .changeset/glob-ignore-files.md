---
"@moonshot-ai/kimi-code": patch
---

Fix glob file searches so all patterns continue to respect ignore files. A positive ripgrep `--glob` always overrides ignore logic, so any non-broad user pattern (e.g. `*.ts`, `dist/**/*.js`) could re-include files excluded by `.gitignore`. The pattern is now filtered in-process after `rg --files` enumerates non-ignored files. Also fixes several glob edge cases: the search path is always `.` so derived prefixes cannot override ignore rules or escape the authorized tree; `*` and `?` before literal parentheses are preserved as wildcards (not treated as extglob prefixes); range braces `{N..M}` match rg's single-alternative behavior; malformed character classes (`[]`, `[!]`, `[z-a]`, dangling `\`) are rejected before running ripgrep; and files whose names start with `..` are no longer dropped as escapes.
