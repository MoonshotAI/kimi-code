---
"@moonshot-ai/agent-core-v2": minor
---

Add an `allow_ignored_globs` option to the workspace `fs:list` request: matching entries are listed even when gitignored, ignored ancestor directories of a match stay traversable, and dot-path allowances require `show_hidden: true`.
