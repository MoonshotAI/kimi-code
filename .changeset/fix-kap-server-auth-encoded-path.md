---
"@moonshot-ai/kimi-code": patch
---

Fix the web server bearer-token check being bypassed by percent-encoded API paths (e.g. `/%61pi/v1/…`), which allowed unauthenticated access to every API route.
