---
"@moonshot-ai/kimi-code": patch
---

web: When several server instances share one home, opening a session held by another instance now redirects to that instance, and the session list refreshes automatically when a peer adds or removes sessions. CLI/SDK clients follow the same redirect transparently.
