---
"@moonshot-ai/kimi-code": patch
---

Keep live sessions stable when an MCP server is removed from the workspace config or uninstalled with its plugin: its tools stay registered in open sessions but calls fail with a removal notice, and the MCP panel shows the removed status. Servers added mid-session — by a plugin install or a config edit — are not registered in open sessions; they take effect in new sessions or after `/new` or `/reload`.
