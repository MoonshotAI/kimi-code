---
"@moonshot-ai/kimi-code": patch
---

The server API's session profile endpoint now ignores the reserved metadata keys `cwd`, `goal`, `parent_session_id`, and `child_session_kind`, as session creation already does.
