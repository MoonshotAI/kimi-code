# Sessions and context

Kimi Code CLI persists every conversation as a "session", preserving message history and metadata so you can close the terminal and resume later. This page covers resuming sessions, context compaction, and managing sessions from inside the TUI.

## Session storage

All sessions are stored under `$KIMI_CODE_HOME/sessions/` (default `~/.kimi-code/sessions/`), bucketed by working directory:

```text
~/.kimi-code/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json` — session title and metadata.
- `agents/*/wire.jsonl` — agent event stream.

::: warning Note
Manually editing files under `sessions/` can leave a session unrecoverable due to ordering constraints in `state.json` and `wire.jsonl`.
:::

## Starting and resuming sessions

By default, `kimi` creates a new session each time. To continue where you left off:

**Resume the most recent session in the current directory:**

```sh
kimi --continue
```

**Resume a specific session:**

```sh
kimi --session abc123
```

`-r` / `--resume` are equivalent aliases.

**Pick interactively:**

```sh
kimi --session
```

::: warning Note
`--continue` and `--session` are mutually exclusive; `--yolo` and `--plan` also cannot be combined with them.
:::

## Switching sessions inside the TUI

- `/new` (`/clear`): switch to a new session.
- `/sessions` (`/resume`): browse and resume past sessions.
- `/fork`: fork the current session (see below).
- `/title <text>` (`/rename`): set a session title for easier recognition. Without an argument, shows the current title.

`/sessions`, `/new`, `/fork`, and `/compact` are only available while idle. During streaming output or context compaction, interrupt the current operation first with `Esc` or `Ctrl-C`.

## Context compaction

Kimi Code CLI automatically compresses message history when context approaches the window limit. You can also trigger it manually:

```text
/compact
```

Pass a custom hint to tell the model what to preserve:

```text
/compact Keep the discussion related to database migrations
```

## Forking sessions

To try a new line of thinking without disrupting the current conversation, use `/fork`:

```text
/fork
```

The forked session is fully independent; you can switch back to the original at any time.

## Exporting sessions

Package a session into a ZIP:

```sh
kimi export <sessionId>
```

Without a `sessionId`, it exports the most recent session (interactively asks for confirmation; pass `-y` to skip). Use `-o` to set the output path:

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

The ZIP is written to the current working directory by default. The session's own diagnostic log is always bundled along with the session directory. The global diagnostic log at `$KIMI_CODE_HOME/logs/kimi-code.log` — which captures events that do not belong to a session, such as TUI startup and login — is also bundled by default; pass `--no-include-global-log` to skip it.

::: tip Tip
Exported files may contain sensitive information. Review the contents before sharing.
:::
