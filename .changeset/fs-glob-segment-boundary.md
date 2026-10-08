---
"@moonshot-ai/agent-core-v2": patch
---

Match workspace fs globs (`include_globs`, `exclude_globs`, `allow_ignored_globs`) with the standard picomatch engine: `a/**/b` no longer matches paths like `a/xxb`, and `a/**` now also matches `a` itself.
