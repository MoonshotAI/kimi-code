---
'@moonshot-ai/kimi-code': patch
---

Fixed MCP OAuth re-authorization always failing with "Invalid redirect URI": the OAuth callback listener binds a random port per flow, but the dynamic client registration recorded the first flow's port, so every later interactive authorization was rejected at the authorization endpoint. A stale registration is now dropped automatically and the flow re-registers with the current callback URI.
