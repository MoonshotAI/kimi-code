---
"@moonshot-ai/agent-core-v2": patch
---

Add a cold-session archive/restore path that patches the persisted metadata document, mirrors the flipped summary into the session-index read model, and republishes the archived bus event without materializing the session, backing the new `POST /api/v2/sessions:archive` / `:restore` batch endpoints (per-item results; live sessions still run the full lifecycle).
