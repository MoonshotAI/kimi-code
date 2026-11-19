---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": patch
"@moonshot-ai/klient": patch
---

Record the identity of the client that creates a session (product, version, platform, display name, and reply style) in session metadata, and use it for that session's system prompt and request headers instead of the server's own identity.
