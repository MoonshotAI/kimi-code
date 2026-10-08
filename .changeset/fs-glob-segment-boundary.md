---
"@moonshot-ai/agent-core-v2": patch
---

Preserve path segment boundaries around `**/` in workspace fs glob matching: `a/**/b` no longer matches paths like `a/xxb` in `include_globs`, `exclude_globs`, and `allow_ignored_globs`.
