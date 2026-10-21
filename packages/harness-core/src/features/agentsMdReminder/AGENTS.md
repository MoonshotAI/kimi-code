# agentsMdReminder

## Resources used

- `useAgent()`: reads the loop history for disclosure records and sends initial, discovery, and change reminders through `loop.remind`.
- `useInject(WorkspaceRef)`: resolves the workspace roots (workspace root plus additional directories) that apply to `workDir` and to tool-accessed paths; falls back to git-root discovery when the facade is absent.
- `useToolEnding`: discovers applicable, undisclosed `AGENTS.md` files from paths accessed by completed tool calls.
- `useStepStarting`: refreshes disclosed paths, resets per-step deduplication, completes the initial disclosure, and checks seeded files for changes at each step boundary.

## Resources exposed

- `AgentsMdReminderRef`: an Agent-scoped facade exposing `seed(paths)` so other Features can add known paths and initialize change tracking; available only when `host` is provided.
- No feature events or durable feature state.

## Business rules

- `workDir`, `host`, and optional `brandHome` are accepted only through props; no environment variables are read. The feature is disabled without `host`.
- AGENTS.md content never enters the system prompt. Files applicable to the workspace roots are disclosed once via an initial path-list reminder; files applicable to paths accessed later by file, search, and Bash tools trigger discovery reminders; created, modified, or deleted seeded files trigger change reminders. All three channels point the agent at paths to read.
- Keeps discovery and change-tracking bookkeeping in memory per agent, using stable reminder keys and disclosure records to suppress duplicates.
