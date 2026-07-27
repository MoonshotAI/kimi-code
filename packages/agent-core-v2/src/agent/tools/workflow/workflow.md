Run a dynamic workflow: a user-approved JavaScript script that orchestrates subagents in phases (parallel fan-out, pipelines, JSON-schema structured output) to complete multi-step work such as deep research.

Provide EITHER `name` (a workflow from the catalog, discovered from the project, user, extra, or builtin roots) OR `script` (an inline workflow script). Every call is reviewed by the user before anything runs — the script may spawn many subagents.

The workflow runs in the background and returns immediately with a run id and a task id. Its completion arrives automatically as a notification in a later turn — do NOT wait, poll, or block on it; continue with other work or hand back to the user. Use TaskOutput with the task id only if the user explicitly asks for intermediate progress.

Prefer `name` over inline `script` when a suitable catalog workflow exists (e.g. the builtin `deep-research` workflow for multi-source fact-checked research). Write an inline `script` only when no catalog workflow fits; keep scripts small and prefer composing `agent()`, `parallel()`, and `pipeline()` over long sequential chains.