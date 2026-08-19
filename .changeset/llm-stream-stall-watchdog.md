---
"@moonshot-ai/kimi-code": patch
---

Fix model requests hanging indefinitely when a provider response stream stalls; stalled requests are now detected and retried automatically with a bounded budget. Retrying a failed step no longer leaves the previous attempt's partial output stuck as a running step in the transcript.
