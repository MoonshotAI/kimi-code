---
"@moonshot-ai/kap-server": patch
---

Sessions created on the local environment with `environment_cwd` load project MCP servers from that working directory's anchor (the nearest project root or checkout root inside the project) and start its stdio servers there; outside the project's directories they fall back to the project root. Such sessions no longer see project servers defined only at the project root when the anchor is a nested checkout.
