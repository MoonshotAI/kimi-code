---
"@moonshot-ai/kimi-code": patch
---

Add a `[secondary_model]` config section so newly spawned subagents can run on a second, separately-configured model: `model` points at any configured model, `default_effort` sets the subagent thinking effort, and any other model field (e.g. `max_output_size`) applies as a subagent-only patch. Individual agents can override this via the new `model_preference` field in their agent file.
