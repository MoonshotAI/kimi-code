---
"@moonshot-ai/kimi-code": minor
---

Make the experimental substitute-model fallback work: on a provider rate limit or quota exhaustion the agent switches to the configured substitute model and returns to the primary after a cooldown. Enable with KIMI_CODE_EXPERIMENTAL_SUBSTITUTE_MODEL=1 and set default_model under [substitute_model] in config.toml.
