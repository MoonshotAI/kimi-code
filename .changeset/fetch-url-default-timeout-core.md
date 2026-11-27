---
"@moonshot-ai/agent-core-v2": patch
---

Add a 30-second deadline to FetchURL execution across provider fallback, redirects, and response body reads, returning a timeout error while preserving user cancellation.
