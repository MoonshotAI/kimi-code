---
"@moonshot-ai/kimi-code": minor
---

Add experimental workspace subagent model bindings, letting a subagent run on a different model and thinking effort than the main session. Set `KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION` and add a `[subagent.<type>]` binding (for example `model = "your-provider/your-model"`) in `.kimi-code/local.toml` to try it.
