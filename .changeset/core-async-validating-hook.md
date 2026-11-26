---
"@moonshot-ai/core": minor
---

The tool executor's `validating` hook may now return its decision asynchronously; synchronous validating hooks keep the previous fully synchronous lifecycle timing.
