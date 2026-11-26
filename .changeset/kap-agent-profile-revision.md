---
"@moonshot-ai/kap-server": patch
---

Add `profile_revision` and `missing_model` to agent state so clients can order settings across `/profile` responses and `agent` frames, and deprecate the setting fields on prompt submissions.
