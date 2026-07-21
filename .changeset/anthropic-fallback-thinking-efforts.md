---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix the model selector offering thinking effort levels a model does not support: non-Claude models on Anthropic-compatible providers (e.g. a catalog-imported Kimi K3) no longer inherit Claude levels such as xhigh/max, and models imported from the models.dev catalog now advertise the effort levels the catalog declares.
