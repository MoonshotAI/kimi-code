---
"@moonshot-ai/kimi-code": patch
---

Add a `[secondary_model]` config section so newly spawned subagents can run on a second, separately-configured model. Individual agents can override this via the new `model_preference` field in their agent file.
