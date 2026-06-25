---
"@moonshot-ai/kimi-code": patch
---

Keep the web session sidebar from re-rendering on every streaming token. The
event reducer now reuses the `sessions` array reference for events that do not
change sessions, so the sidebar computeds (`sessionsForView` / `workspaceGroups`
/ `mergedWorkspaces`) are no longer dirtied by unrelated high-frequency events.
