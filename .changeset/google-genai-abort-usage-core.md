---
"@moonshot-ai/core": patch
---

Forward request cancellation to the Google GenAI SDK so aborting closes the underlying HTTP connection, and report streamed usage metadata as soon as it arrives instead of waiting for a finish reason.
