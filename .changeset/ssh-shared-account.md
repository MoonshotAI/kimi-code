---
"@moonshot-ai/kimi-code": patch
---

Keep full SSH host management and share the local Kimi account with remote agents. Hosts receive only a short-lived access token; the login and its renewal stay on the connecting computer, so remote model requests fail once the token expires while that computer is offline.
