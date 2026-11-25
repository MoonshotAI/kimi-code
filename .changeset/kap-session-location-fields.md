---
"@moonshot-ai/kap-server": minor
---

Add `workspace_root` to `POST /api/v1/sessions` to choose the project, and report `workspace_root`, `environment_id`, and `environment_cwd` on every session view plus `environment_cwd` on `GET /api/v1/sessions/{session_id}/environment`. The request `cwd` and `metadata.cwd`, the session `cwd`, and the environment `cwd` still work and are marked deprecated. A create request with neither `workspace_id` nor a project root now reports `workspace_root` in its 40001 details.
