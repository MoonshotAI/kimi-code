---
"@moonshot-ai/kimi-code": patch
---

Send the CLI's device identity headers with OAuth login and token refresh requests from kimi web, tag web-UI requests with a `(web)` User-Agent suffix so upstream can tell them apart from direct CLI traffic, and record the host product version in session export manifests.
