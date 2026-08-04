---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fix the built-in capability rows (Kimi Computer Use, Kimi WebBridge) missing from `/plugins` before the first session exists: capability status and installs now resolve through the app-global channel like plugin management, so the Official tab and setup actions work on a session-less v2 startup.
