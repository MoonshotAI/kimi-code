---
"@moonshot-ai/kimi-code": patch
---

Resolve `@` file mentions to real paths before sending, so the model no longer treats the `@` as part of the filename. Existence-verified mentions (relative, absolute, `~/`, quoted, or with trailing CJK punctuation) are rewritten to absolute paths on submit; unresolved tokens like `@types/node` pass through untouched. Scoped mentions containing a `/` now navigate that directory shell-style (prefix matches first, hidden entries only for dot fragments) instead of a recursive fuzzy search that surfaced `~/.Trash/**` above `~/Downloads`.
