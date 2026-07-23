---
"@moonshot-ai/kimi-code": minor
---

Extend the experimental workspace subagent model bindings: the Agent tool now interactively asks for a model the first time an unbound subagent type or binding slot is spawned — or when a stored binding references a model alias that no longer exists — and records the answer, including a "keep inheriting" choice, in `.kimi-code/local.toml`. Set `KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION` and spawn a subagent type that has no `[subagent.<type>]` binding to try it.
