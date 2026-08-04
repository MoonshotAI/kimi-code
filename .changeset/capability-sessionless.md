---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fix the built-in capability rows (Kimi Computer Use, Kimi WebBridge) missing from `/plugins`: capability status and installs now resolve through the app-global channel like plugin management, so they work on a session-less v2 startup, and the rows also show up under the dev marketplace server (which serves this repo's own catalog and is no longer mistaken for a user override).
