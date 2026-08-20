---
"@moonshot-ai/kimi-code-sdk": patch
---

Add an optional cwd parameter to global MCP management and authorization methods for project-layer-aware operations. MCP auth-status reads preserve implicit OAuth detection by default; pass verify: false for stored-credential-only classification or verify: true to verify every candidate.
