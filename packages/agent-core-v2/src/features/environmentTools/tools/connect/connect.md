Create a temporary environment from a launcher spec — an SSH host, a Docker-compatible container, or a custom launcher command — and connect to it, without writing anything to `config.toml`.

Use this when you need an environment that is not declared yet: ad-hoc hosts, throwaway containers, or one-off targets the user named in the conversation. The new environment is registered in the session's workspace so you can switch to it with `change_environment`, or bind a subagent to it via the Agent tool's `environment` parameter.

- The environment connects eagerly: the tool call returns the target's OS, shell, and initial working directory, or the connection failure (including install guidance when the remote executor is missing).
- Temporary environments are not persisted: they vanish when the process exits, they cannot be reconnected after a connection drop (create a fresh one instead), and a session resumed onto one finds it gone — switch back to `local` (or another environment) before ending the session if the work should continue later.
- Prefer declared environments (`/environment` add, or the `[environments]` config section) for targets that are reused across sessions.

Not available in plan mode (call ExitPlanMode first) or while tower mode is active. 
