---
"@moonshot-ai/kap-server": minor
---

`POST /api/v1/workspaces/{workspace_id}/primary` now rejects implicit workspaces with the new error code `40941` instead of changing their primary directory; managed workspaces are unaffected.
