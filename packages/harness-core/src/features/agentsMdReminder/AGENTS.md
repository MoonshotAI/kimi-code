# agentsMdReminder

## Resources used

- `useAgent()`: reads the current system prompt to identify injected `AGENTS.md` files and sends discovery and change reminders through `loop.remind`.
- `useLoopEvent('system_prompt.settled')`: extracts `AGENTS.md` paths after system prompt updates to seed known paths and initialize change tracking.
- `useToolEnding`: discovers applicable, undisclosed `AGENTS.md` files from paths accessed by completed tool calls.
- `useStepStarting`: refreshes disclosed paths, resets per-step deduplication, and checks seeded files for changes at each step boundary.

## Resources exposed

- `AgentsMdReminderRef`: an Agent-scoped facade exposing `seed(paths)` so other Features can add known paths and initialize change tracking; available only when `host` is provided.
- No feature events or durable feature state.

## Business rules

- `workDir`, `host`, and optional `brandHome` are accepted only through props; no environment variables are read. The feature is disabled without `host`.
- Covers paths accessed by file, search, and Bash tools; reminds the agent about missed `AGENTS.md` files and about created, modified, or deleted injected files.
- Keeps discovery and change-tracking bookkeeping in memory per agent, using stable reminder keys and disclosure records to suppress duplicates.
