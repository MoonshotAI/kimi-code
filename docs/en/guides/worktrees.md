# Git worktrees

A Git worktree (an extra, independent checkout linked to the same Git repository) lets you run parallel sessions in isolated directories without disturbing uncommitted changes in your main checkout or switching branches back and forth.

::: info Note
Git worktrees are experimental and disabled by default.
:::

## Enabling Git worktrees

Turn the feature on using any of these options:

- **In the TUI**: run `/experiments`, enable **Git worktrees**, and apply. It takes effect right away with no restart.
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

While idle in a local Git repository, run `/worktree` to view and manage worktrees for the current repository. Type or paste to filter, press `Enter` to switch, `Ctrl-N` to create a new worktree, or `Ctrl-X` to delete a non-current worktree.

## Starting in a worktree from the CLI with `kimi -w`

Run `kimi -w` (or `kimi --worktree`) inside any local Git repository to create a managed worktree under `$KIMI_CODE_HOME/worktrees/` and open a session there. Because managed worktrees live under your Kimi data directory, they never add untracked folders to your repository and require no `.gitignore` changes.

```sh
# Generate a random name like 1125-kimi from the current HEAD
kimi -w

# Choose a name
kimi -w fix-auth

# Start from a specific branch, tag, or commit
kimi -w fix-auth --worktree-base main
```

New worktrees start on a detached HEAD (not tied to a local branch) so they never collide with existing branches, and uncommitted edits in your source checkout stay where they are. Running `kimi -w` from a subdirectory opens the matching subdirectory in the new worktree when it exists.

`-w` also works in non-interactive [print mode](../reference/kimi-command.md#print-mode):

```sh
kimi -p "Fix the login retry logic and run the tests" -w fix-auth
```

::: warning Note
Using `-w` in print mode requires the project to be trusted first so repository Git hooks (such as `post-checkout`) cannot run in an untrusted repository. Run `kimi` here and choose "Trust and continue", or set `KIMI_CODE_TRUST_WORKSPACE=1` when you trust the workspace.
:::

Print mode leaves the worktree on disk when it finishes and prints its path and commit status to `stderr` so you can inspect or remove it later.

## Copying ignored files and setup scripts

Git worktrees only check out tracked files by default. If a new worktree needs ignored local files or automatic environment setup such as installing dependencies, add `.worktreeinclude` or `.kimi-code/worktree-setup.sh` to your repository. Both can be committed and shared with your team: `.worktreeinclude` handles simple file-copying cases, while `.kimi-code/worktree-setup.sh` runs custom setup commands.

### `.worktreeinclude`

Create a `.worktreeinclude` file at the repository root using `.gitignore` syntax to list ignored local files that should be copied into each new worktree:

```text
.env
.env.local
config/local.json
```

Kimi Code CLI copies only regular files ignored by Git and never overwrites files that already exist in the new worktree.

### `.kimi-code/worktree-setup.sh`

Add `.kimi-code/worktree-setup.sh` to prepare the environment right after a worktree is created, for example to install dependencies:

```sh
#!/bin/sh
set -e
pnpm install
```

The script runs once during creation, right after `.worktreeinclude` files are copied and before the session enters the new worktree, and is not re-run when you switch back later. Kimi Code CLI runs the script from the new worktree first, falling back to the source checkout when the file does not exist in the new worktree (for example, an uncommitted local script or an older base commit). It runs with the new worktree root as the working directory and provides two environment variables:

- **`KIMI_CODE_WORKTREE_SOURCE_DIR`**: root directory of the source checkout.
- **`KIMI_CODE_WORKTREE_DIR`**: root directory of the newly created worktree.

In the TUI, Kimi Code CLI asks whether to run or skip the script on each creation. In print mode, it runs automatically once the project is trusted.

## Cleanup when exiting

When you exit the TUI from a Kimi-managed worktree:

- **Open in another window**: keeps the worktree and exits.
- **All other cases**: opens a confirmation prompt (defaulting to keep) showing uncommitted files, unique commits, and any active tasks so you can choose whether to keep or delete it. If you choose delete, Kimi Code CLI closes the session and stops running turns and background tasks before removing the directory.

## Next steps

- [Sessions and context](./sessions.md) — learn about the 3-tab `/sessions` picker in Git repositories and same-project resume
- [kimi command reference](../reference/kimi-command.md) — full option reference for `-w`, `--worktree-base`, and other flags
- [Data locations](../configuration/data-locations.md) — see where managed worktrees are stored
