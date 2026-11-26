# Git worktrees

A Git worktree (an extra, independent checkout linked to the same Git repository) lets you run parallel sessions in isolated directories without disturbing uncommitted changes in your main checkout or switching branches back and forth.

::: info Note
Git worktrees are in Beta and disabled by default.
:::

## Enabling Git worktrees

Turn the feature on using any of these options:

- **In the TUI**: run `/lab` and enable **Git worktrees** (or **Enable all Beta features**; takes effect immediately).
- **In your config file**: add the following to `~/.kimi-code/config.toml`:

```toml
[experimental]
worktree = true
```

- **For a single launch**: set the [environment variable](../configuration/env-vars.md#runtime-switches):

```sh
KIMI_CODE_EXPERIMENTAL_WORKTREE=1 kimi -w
```

## Managing worktrees in the TUI with `/worktree`

Run `/worktree` in a local Git repository to list, create, switch into, and delete worktrees for the current repository.

## Starting in a worktree from the CLI with `kimi -w`

Run `kimi -w` (or `kimi --worktree`) inside a local Git repository to create a managed worktree under `$KIMI_CODE_HOME/worktrees/` and start working there. Because managed worktrees live under your Kimi data directory, they never add untracked folders to your repository and require no `.gitignore` changes.

```sh
# Create from the current HEAD with an auto-generated name (for example, 1202-kimi)
kimi -w

# Choose a name
kimi -w fix-auth

# Start from a specific branch, tag, or commit
kimi -w fix-auth --worktree-base main
```

New worktrees start on a detached HEAD (not tied to a local branch), so they do not occupy existing branches or copy uncommitted edits from the source checkout.

`-w` also works in non-interactive [print mode](../reference/kimi-command.md#print-mode):

```sh
kimi -p "Fix the login retry logic and run the tests" -w fix-auth
```

::: warning Note
Using `-w` in print mode requires the project to be trusted first: run `kimi` here to trust it, or set `KIMI_CODE_TRUST_WORKSPACE=1`.
:::

Print mode keeps the worktree when it finishes and prints its path so you can inspect or remove it later.

## Copying ignored files and setup scripts

Git worktrees only include tracked files by default. When a new worktree needs ignored local files or automatic environment setup, add `.worktreeinclude` and `.kimi-code/worktree-setup.sh` to your repository (both can be committed and shared with your team).

### `.worktreeinclude`

Create `.worktreeinclude` at the repository root using `.gitignore` syntax to list ignored files to copy into each new worktree:

```text
.env
.env.local
config/local.json
```

Only Git-ignored files are copied, and existing files in the new worktree are never overwritten.

### `.kimi-code/worktree-setup.sh`

Add `.kimi-code/worktree-setup.sh` to prepare the environment when a worktree is created, such as installing dependencies:

```sh
#!/bin/sh
set -e
pnpm install
```

The script runs once on creation (never again when switching back), preferring the copy inside the new worktree and falling back to the source checkout when absent. It runs in the new worktree root with two environment variables:

- **`KIMI_CODE_WORKTREE_SOURCE_DIR`**: root directory of the source checkout.
- **`KIMI_CODE_WORKTREE_DIR`**: root directory of the new worktree.

In the TUI, Kimi Code CLI asks whether to run the script on each creation; in print mode, it runs automatically once the project is trusted.

## Cleanup when exiting

When exiting the TUI from a managed worktree that is not open in another window, Kimi Code CLI prompts you to keep or delete it (defaulting to keep).

## Next steps

- [Sessions and context](./sessions.md) — resume and manage sessions
- [kimi command reference](../reference/kimi-command.md) — full launch option reference
- [Data locations](../configuration/data-locations.md) — see where managed worktrees are stored
