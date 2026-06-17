---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Restore the turn counter from persisted loop events on resume so post-resume turns no longer reuse turn ids that already appear in history.
