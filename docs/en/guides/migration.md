# Migrating from kimi-cli

::: info
Kimi Code CLI has gone through a major version upgrade — moving from Python/uv to Node.js, bringing a simpler install experience, faster startup, and a redesigned terminal UI. The legacy version will gradually be phased out, so we recommend upgrading as soon as possible.
:::

If you are migrating from the legacy version, follow the steps below — a single command migrates your config, MCP servers, and session history to the new version.

## Which CLI should I use?

`kimi-cli` and Kimi Code CLI are two generations of the terminal coding agent from the same team. For a new installation, use Kimi Code CLI. `kimi-cli` remains available for existing installations while that project is gradually wound down.

| | `kimi-cli` | Kimi Code CLI |
| --- | --- | --- |
| Status | Earlier implementation, kept available for existing installations | Current generation, recommended for new installations |
| Implementation | Python application installed with `uv` | TypeScript/Node.js codebase distributed as a standalone binary; users do not need to install Node.js |
| Data directory | `~/.kimi/` | `~/.kimi-code/` |
| Migration role | Source of supported config and optional session data | Destination for data imported by `kimi migrate` |

Kimi Code CLI is a separate implementation, not an in-place update of the Python package. The migration command copies supported data into the new data directory without changing or deleting your `kimi-cli` data.

## What's new

- **No more Python / uv**: Rebuilt on Node.js — no Python environment needed, simpler to install
- **Native binary, works out of the box**: Faster startup, lighter footprint
- **Redesigned terminal UI**: Smoother, more responsive experience
- **Full data migration**: Config, MCP servers, and session history all carry over seamlessly

## How to migrate

There are two ways to migrate.

The **first time you run `kimi`** after installing kimi-code, it automatically checks whether kimi-cli data exists under `~/.kimi/`. If it finds any, a migration prompt appears, and you can choose to migrate now, do it later, or never be asked again.

You can also **run it manually at any time**:

```sh
kimi migrate
```

You can choose whether to migrate chat sessions as well. If you don't need the history yet, pick **Config only**; otherwise pick **Config + N sessions** to bring everything across in one go. A summary is printed at the end.

## What happens during migration

**What gets migrated**: configuration (`config.toml`), MCP server configuration, input history, and whichever chat sessions you chose to migrate.

**What does not get migrated**: OAuth login credentials and MCP service authorizations are not copied, so you will need to run `/login` again and re-authorize MCP servers after migrating. kimi-cli plugins are also out of scope.

::: tip
Migration **never modifies or deletes** any of the old data under `~/.kimi/`. kimi-cli keeps working as before, and the two do not interfere with each other. Migration can also be run repeatedly — sessions that have already been migrated are not imported again.
:::

After migration, sessions imported from kimi-cli are tagged with `[imported]` in the session picker so you can tell them apart from new ones.
