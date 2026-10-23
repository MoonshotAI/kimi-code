---
"@moonshot-ai/kimi-code": minor
---

Add `tools.search.follow_gitignore = false` to config.toml to make Glob and Grep search gitignored files (such as build outputs) by default. The existing `include_ignored` parameter on each tool still works as a per-call override.
