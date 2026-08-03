---
"@moonshot-ai/kap-server": patch
---

Add the global `event.config.warning` WebSocket event that pushes the current set of config warnings (deprecated config keys or environment variables in use) to every connection whenever it changes.
