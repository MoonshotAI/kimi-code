---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/klient": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/acp-server": patch
---

Import the engine's renamed Project services, types and modules in place of the Workspace ones. Exported names, including klient's `Workspace` and `WorkspaceUpdate` types, KAP routes and fields, and behavior are unchanged.
