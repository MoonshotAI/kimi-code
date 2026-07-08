---
"@moonshot-ai/kimi-code": patch
---

Classify provider "request body too large" rejections (HTTP 413) as a dedicated error type, distinguishing them from token context overflow so oversized-media failures can be handled separately.
