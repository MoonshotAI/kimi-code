Switch the session's environment binding to another environment: subsequent turns execute tool calls (file operations, Bash, terminals) on that environment instead of the current one.

Use this when the task at hand belongs on a different machine or container than the one you are currently on — for example running commands on a staging host, or coming back to `local` for files on the user's machine.

- Pass the environment `id` from the available environments list (`local` or a declared/temporary environment id), and the working directory `cwd` on the target. `cwd` may be omitted when the environment's declaration sets `defaultCwd`, or when switching to `local`.
- The switch takes effect as soon as this tool call completes: subsequent tool calls in the same turn already run on the new environment. The call fails when other tool calls are still executing in parallel, so run it on its own and retry once they have finished. A reminder with the new environment's OS, shell, and working directory is queued for the next turn.
- Connecting happens eagerly: if the target environment is disconnected, this tool connects it first, and a connection or `cwd` validation failure is reported immediately without changing the current binding.
- The switch is recorded like a user-driven `/environment` switch, so undo restores the previous binding.

Not available in plan mode (call ExitPlanMode first) or while tower mode is active.
