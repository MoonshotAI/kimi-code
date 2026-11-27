# Git worktrees

A Git worktree (an extra, independent checkout linked to the same Git repository) lets you run parallel sessions in isolated directories without disturbing uncommitted changes in your main checkout or switching branches back and forth.

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

Print mode keeps the worktree when it finishes and prints its path so you can inspect or remove it later.

## Copying ignored files

Git worktrees only include tracked files by default. To copy local files ignored by `.gitignore` into each new worktree, create `.worktreeinclude` at the repository root using `.gitignore` syntax (this file can be committed and shared with your team):

```text
.env
.env.local
config/local.json
```

Only Git-ignored files are copied, and existing files in the new worktree are never overwritten.

## Cleanup when exiting

When exiting the TUI from a managed worktree that is not open in another window, Kimi Code CLI prompts you to keep or delete it (defaulting to keep).

## Next steps

- [Sessions and context](./sessions.md) — resume and manage sessions
- [kimi command reference](../reference/kimi-command.md) — full launch option reference
- [Data locations](../configuration/data-locations.md) — see where managed worktrees are stored
