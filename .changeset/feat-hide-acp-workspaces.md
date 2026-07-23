---
"@moonshot-ai/acp-adapter": patch
"@moonshot-ai/kimi-web": patch
---

Tag ACP-created sessions with `source: 'acp'` (plus the client's `clientInfo.name`) in their persisted custom metadata, and add a kimi-web setting (on by default) that hides ACP-created sessions and ACP-only workspaces from the sidebar and archived lists.
