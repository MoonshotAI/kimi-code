Find files by glob pattern, sorted by modification time (most recent first).

Powered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).

Good patterns:
- `*.ts` — recursive from the search root; `src/*.ts` — only directly inside `src/`
- `src/**/*.ts` — recursive beneath `src/`
- `*.{ts,tsx}` and `{src,test}/**/*.ts` — brace expansion

Follow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.

Avoid broad searches in dependency or build-output directories, especially with `include_ignored`; prefer a narrow `path` or `pattern`.
