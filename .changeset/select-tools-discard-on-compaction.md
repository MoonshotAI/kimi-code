---
"@moonshot-ai/kimi-code": patch
---

Progressive tool disclosure (`select_tools`, experimental): compaction now discards the loaded tool schemas instead of re-injecting them. After a compaction the boundary announcement re-lists every loadable tool name and the model re-selects what it still needs; a from-memory call to a no-longer-loaded tool is rejected with guidance to select it first. This keeps the post-compaction context at its minimal users+summary floor and removes the schema-rebuild budget heuristics. No effect unless the `tool-select` experimental flag and a `select_tools`-capable model are active.
