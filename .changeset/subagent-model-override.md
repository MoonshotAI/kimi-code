---
"@moonshot-ai/agent-core": minor
---

Enable the secondary-model feature by default (opt out with `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=0` or `[experimental] secondary-model = false`), and let the `Agent`/`AgentSwarm` `model` parameter and profile `modelPreference`/`model_preference` name any configured `[models]` alias — unknown aliases fail the tool call at spawn time with the valid choices listed.
