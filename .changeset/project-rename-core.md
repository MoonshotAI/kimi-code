---
"@moonshot-ai/agent-core-v2": patch
---

Rename the Workspace concept in the code to Project, and the session's workspace context to workdir context. Exported services, types and functions, their module paths (for example `app/workspace/*` is now `app/project/*` and `workspace/*` is now `project/*`), and the files and directories use the new names. On-disk formats, including the `[workspace]` section of `local.toml` and the fields of `projects.json`, KAP field names such as `workspace_id`, string identifiers and behavior are unchanged.
