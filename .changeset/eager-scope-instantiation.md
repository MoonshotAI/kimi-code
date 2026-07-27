---
"@moonshot-ai/kimi-code": patch
---

Instantiate every registered service eagerly at scope creation on the experimental engine, following the dependency graph automatically, and drop the hand-maintained lists that resolved side-effect services one by one at startup.
