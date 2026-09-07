---
"@moonshot-ai/kimi-code": patch
---

Fix sessions permanently wedging after interrupting a response (ESC) mid-thinking: the leftover reasoning-only assistant message is now dropped from outgoing requests instead of being sent empty and rejected by the provider.
