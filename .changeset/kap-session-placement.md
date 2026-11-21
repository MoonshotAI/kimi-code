---
"@moonshot-ai/kap-server": minor
---

Place sessions created through `POST /api/v1/sessions` with the core's implicit-project resolver: a request with only `cwd` inside a git repository joins the implicit workspace of the repository's main checkout, and a request with `workspace_id` and `cwd` requires `cwd` to be inside the workspace's directories or another checkout of the same repository, returning `40001` otherwise; paths are compared after resolving symlinks, so a symlink inside the workspace that points outside it is rejected and a symlinked spelling of the workspace root is accepted. New local sessions stay at their starting directory, `Session.cwd` reports the session's own working directory, sessions created by earlier versions report the current workspace root on get, wait and fork, and `GET /api/v1/sessions/{session_id}/environment` reports the working directory of new local sessions. Clients older than CLI 2.5.0 and desktop 1.4.0 run such sessions at the workspace root.
