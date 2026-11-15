# Sessions and context

Kimi Code CLI persists every conversation as a "session" — storing message history and metadata so you can close the terminal and pick up right where you left off. This page covers how to resume sessions, manage context, and export or fork sessions.

## Session storage

All sessions are saved under `$KIMI_CODE_HOME/sessions/` (default: `~/.kimi-code/sessions/`), grouped by working directory:

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

- `state.json`: session metadata such as title and creation time.
- `agents/*/wire.jsonl`: the agent event stream, used for session recovery and replay. It also carries a request trace — the tool schemas, request parameters, and MCP tool listings sent to the model — for debugging.

::: warning
Do not manually edit files inside the `sessions/` directory — doing so may prevent sessions from being restored correctly.
:::

## Starting and resuming sessions

Every time you run `kimi` directly it creates a new session. To resume a previous session, use one of the following:

**Resume the most recent session in the current directory:**

```sh
kimi --continue
```

**Resume a specific session by ID:**

```sh
kimi --session abc123
```

**Interactively browse session history and choose one:**

```sh
kimi --session
```

When a session is being restored, the TUI shows progress while it attempts the session's recorded environment connection.

::: warning
`--continue` and `--session` are mutually exclusive.
:::

## Switching sessions inside the TUI

You can manage sessions without leaving the terminal. The following slash commands are available only when the agent is idle:

- **`/new`** (alias `/clear`): switch to a new session in the current environment, discarding the conversation. The environment and its working directory stay; only the context is cleared.
- **`/sessions`** (alias `/resume`): browse and resume a previous session.
- **`/fork`**: fork the current session (see below).
- **`/title <text>`** (alias `/rename`): set a session title for easier identification; without arguments, displays the current title.

## Context compression

As a conversation grows, Kimi Code CLI automatically compresses the message history when the context approaches the window limit, freeing up token space. You can also trigger compression manually at any time:

```
/compact
```

You can pass a hint to tell the model what to prioritize when compressing:

```
/compact Keep the discussion about database migrations
```

Typing `/compact` while the agent is running joins the message queue and runs when its turn comes; a duplicate `/compact` is refused while one is already queued; if the context was auto-compacted while it waited, the queued command is skipped.

## Forking a session

To explore a new direction without disrupting the current conversation, use `/fork`:

```
/fork
```

Forking does not switch you away: you stay in the original session and the conversation continues untouched. The fork is an independent copy you can switch to at any time using `/sessions`. A saved `/goal` is not copied to the fork. Start a new goal there if you want autonomous goal work.

After forking, the CLI prints a ready-to-run `kimi --resume` command (also copied to the clipboard) so you can enter the fork directly from a new terminal process.

## Exporting a session

Use `kimi export` to package a session as a ZIP file — useful for sharing, archiving, or filing a bug report:

```sh
kimi export <sessionId>
```

Omitting `sessionId` exports the most recent session in the current directory (with an interactive confirmation prompt; add `-y` to skip). Use `-o` to specify an output path:

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

The export includes all files in the session directory, including diagnostic logs. The global diagnostic log (`~/.kimi-code/logs/kimi-code.log`) is also bundled by default; add `--no-include-global-log` to exclude it.

You can also export from inside the TUI without leaving the interactive session:

- **`/export-debug-zip`**: produces the same debug ZIP as `kimi export`.
- **`/export-md`** (alias `/export`): exports the conversation as a human-readable Markdown file, suitable for sharing or archiving. Accepts an optional path argument; without one, it writes to `kimi-export-<short-id>-<timestamp>.md` in the current working directory.

In the web UI, `/export` downloads the current session as a diagnostic ZIP. It includes the persisted session data, diagnostic logs, and a bounded metadata-only `logs/kimi-web.jsonl` record of key browser events. Prompt text, WebSocket payloads, and console arguments are not copied into this browser log. This web command differs from the TUI `/export` alias above.

::: tip
Exported files may contain code, command output, and file paths that are sensitive. Review the content before sharing.
:::

## Importing sessions from Claude Code and Codex

To continue work you started in Claude Code or Codex, import those sessions as regular Kimi Code sessions:

```sh
kimi import-sessions
```

Inside the TUI, `/import-sessions` opens the same page. Choose the last 15 days (the default) or the last 30 days. Each run imports at most the newest 100 sessions. Sessions imported before, and sessions whose project folder no longer exists, are skipped.

Imported sessions return to the workspace of their original project folder and keep their title and last activity time: run `kimi` in that folder and use `/sessions` to find them, marked `[Claude Code]` or `[Codex]`. An imported session starts with one message that holds the imported conversation, with tool calls and results as short text notes, together with where the conversation came from and where its complete history is saved. It includes as many recent turns as fit while leaving room to keep working before the context is compacted; the complete history and a copy of the original session files are saved with the session, so the agent can look up earlier details.

Conversion runs locally: the original session files are not changed and no model is called.

## Next steps

- [Data locations](../configuration/data-locations.md) — full directory layout for session files
- [kimi command reference](../reference/kimi-command.md) — complete parameter reference for `--continue`, `--session`, `export`, and other commands
