---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Follow symbolic links when enumerating directories in the host folder browser, skipping broken, looped, and permission-denied links while propagating unexpected filesystem stat failures.
