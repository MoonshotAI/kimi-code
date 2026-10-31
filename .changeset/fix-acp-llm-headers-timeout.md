---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/acp-server": patch
"@moonshot-ai/agent-core-v2": patch
---

Ensure ACP mode forwards device identity headers on outbound model requests and honors KIMI_CODE_ACP_LLM_TIMEOUT_MS so long-thinking models do not prematurely time out.
