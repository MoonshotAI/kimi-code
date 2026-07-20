---
'kimi-code': minor
---

feat(plugins): add Vercel MCP plugin

Introduces `kimi-vercel`, an official MCP plugin for managing Vercel projects and deployments.

**New plugin:** `plugins/official/kimi-vercel/`
- `bin/kimi-vercel.mjs` – MCP server (stdio transport) that talks to the Vercel REST API
- `kimi.plugin.json` – Plugin manifest
- `SKILL.md` – Plugin documentation

**Provided tools:**

| Tool | Description |
|---|---|
| `vercel_list_projects` | List all Vercel projects for the authenticated user |
| `vercel_get_project` | Get details of a specific project by name or ID |
| `vercel_list_deployments` | List deployments for a project |
| `vercel_get_deployment` | Get details of a deployment by ID or URL |

**Setup:** Set `VERCEL_TOKEN` environment variable with a Vercel personal access token.
