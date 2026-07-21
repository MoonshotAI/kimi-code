---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add the `dual-model-routing` experimental feature: route the main agent and its subagents to different models.

When the feature is enabled (via `/experiments`, `KIMI_CODE_EXPERIMENTAL_DUAL_MODEL_ROUTING`, or the master `KIMI_CODE_EXPERIMENTAL_FLAG` switch), subagents use a dedicated subagent model instead of inheriting the main agent's model. The subagent model defaults to the new `default_subagent_model` config field and can be switched live via `/model`, which now opens a scope picker (Main agent / Subagents) when the feature is active. The footer status bar shows both the main and subagent models while the feature is on. Subagent thinking effort is also separable: it defaults to the new `default_subagent_thinking_effort` config field and can be switched live via the same `/model` scope picker (the chosen effort is persisted alongside the model). Note that the dedicated model and effort apply to delegated subagents only — the side-question (`/btw`) agent always inherits the main agent's model and effort, because it replays the main agent's prompt prefix and shares its prefix cache, so routing it elsewhere would re-process the whole conversation on a cold cache.

When the feature is disabled, all UI and runtime behavior is unchanged — subagents inherit the parent model as before, the footer shows only the main model, and `/model` keeps its singular behavior.
