---
"@moonshot-ai/agent-core-v2": patch
---

Route FetchURL through the managed Kimi fetch service when the Kimi provider is logged in, with automatic fallback to local fetching on failure, and forward the host identity headers with the request.
