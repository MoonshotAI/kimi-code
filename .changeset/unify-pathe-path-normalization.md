---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kaos": patch
"@moonshot-ai/kimi-code": patch
---

Unify path normalization by replacing ad-hoc `toForwardSlashes` helpers with `pathe`. Remove unnecessary `node:path/win32` branching in path-access policies and tools, and inline unused `joinPath` wrappers. Platform-specific path separators are now handled consistently through a single module.