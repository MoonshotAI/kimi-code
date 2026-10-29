Execute a `${SHELL_NAME}` command.

Prefer the dedicated tools over shell equivalents — `Read` over `cat`/`head`/`tail`, `Edit` over in-place `sed`/`awk`, `Write` over `echo >` or heredocs, `Glob` over `find`, `Grep` over `grep`/`rg` — since they apply the workspace's path and secret-file policies and cap their output.

Each call runs in a fresh shell: variables and `cd` do not persist, so pass `cwd` or use absolute paths. Commands get no interactive input. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with `Command failed with exit code: N`. ${TIMEOUT_GUIDANCE}

${BACKGROUND_GUIDANCE}

- Do not reach outside the working directory with `..` paths or modify files outside it unless explicitly instructed.
- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as `git commit`, `git push`, `git reset`, and `git rebase` only when the user asks for them.
- For GitHub work, prefer the `gh` CLI when installed; it carries the user's GitHub auth.
