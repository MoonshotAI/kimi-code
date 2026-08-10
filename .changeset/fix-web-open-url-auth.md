---
"@moonshot-ai/kimi-code": patch
---

Fix kimi web opening an unauthenticated page: the opened URL now carries the server token, and the wrapper hands the Rust binary the bundled web assets.
