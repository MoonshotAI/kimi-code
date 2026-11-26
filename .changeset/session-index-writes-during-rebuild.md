---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Keep the session summaries the read model mirror writes while a new session index generation is being built, and write them into that generation once it is published, so a session created or changed during the rebuild no longer goes missing or stale in session lists and counts until the next periodic reconciliation. Session counts now wait for an in-flight mirror flush, read the generation that is published at that point, and read again when a mirror flush lands mid-read. A project primary that changes during the rebuild now starts another rebuild right away, up to three rounds, instead of waiting for that reconciliation.
