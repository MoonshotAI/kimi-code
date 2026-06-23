---
"@moonshot-ai/kimi-web": patch
---

Surface workspace directory errors in @-mention search and validate the working directory before creating any new session.

- `@mention` now shows the backend error (e.g. deleted directory) instead of "no match" when `fs:search` fails.
- Session creation via the new-session dialog, workspace "+", and the onboarding composer now verifies the cwd with `browseFs` first and surfaces the error instead of creating a session in a missing directory.

Note: `browseFs` in the daemon API client now propagates errors instead of returning an empty result. The workspace-state layer still exposes a defensive wrapper (`workspaceState.browseFs`) used by the folder picker, so existing picker behavior is unchanged.
