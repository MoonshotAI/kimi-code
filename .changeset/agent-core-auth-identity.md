---
"@moonshot-ai/agent-core": patch
---

Thread the host identity through the managed auth facades so OAuth token refreshes from inside the core carry the `X-Msh-*` device headers.
