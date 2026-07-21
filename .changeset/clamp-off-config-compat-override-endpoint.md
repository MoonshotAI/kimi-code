---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Close three follow-up gaps: a configured `thinking.effort = "off"` no longer bypasses the always-on clamp (it is treated as absent and the model default applies, on both engines); the previously public `inferWireType` is kept as a deprecated compatibility wrapper over the new catalog import resolver; and catalog model overrides that stay on the provider's wire but declare their own endpoint now persist that endpoint on the alias instead of being silently routed to the provider's base URL.
