# Vercel for Kimi Code

An MCP plugin that lets Kimi Code interact with [Vercel](https://vercel.com) projects and deployments.

## Setup

You need a Vercel personal access token. Get one from [Vercel Dashboard → Settings → Tokens](https://vercel.com/account/tokens), then set the environment variable:

```bash
export VERCEL_TOKEN=<your-token>
```

## Provided Tools

- `vercel_list_projects` – List all Vercel projects for the authenticated user.
- `vercel_get_project` – Get details of a specific project by name or ID.
- `vercel_list_deployments` – List deployments for a project.
- `vercel_get_deployment` – Get details of a deployment by ID or URL.

## Usage

Ask Kimi Code to:

- "List my Vercel projects"
- "Show deployments for my-project"
- "Get details of deployment dpl_xxx"
- "What's the status of my-project-xxx.vercel.app?"

## Requirements

- Node.js 18+
- A Vercel account with a personal access token
