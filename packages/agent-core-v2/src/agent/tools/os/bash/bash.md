Execute a `${SHELL_NAME}` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `Read`
- `sed` / `awk` (in-place edit) → `Edit`
- `echo > file` / `cat <<EOF` → `Write`
- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)
- `grep` / `rg` (search file contents) → `Grep`
- `echo` / `printf` (talk to the user) → just output text directly

Each call runs in a fresh shell: variables and `cd` do not persist, so pass `cwd` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with `Command failed with exit code: N`. Do not run interactive commands or commands that never exit. ${TIMEOUT_GUIDANCE}

${BACKGROUND_GUIDANCE}

- Use `&&` for commands that depend on each other. Issue independent read-only commands (separate `git show`, `ls`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with `echo` separators.
- Avoid `..` paths outside the working directory, and do not modify files outside it unless explicitly instructed.
- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as `git commit`, `git push`, `git reset`, and `git rebase` only when the user asks for them.
- Command availability depends on the host; run `which <command>` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the `gh` CLI when installed.
