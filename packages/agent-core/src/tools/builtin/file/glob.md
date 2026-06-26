Find files by glob pattern, sorted by modification time (most recent first).

Powered by ripgrep. Respects `.gitignore`, `.ignore`, and `.rgignore` by default — set `include_ignored` to also match ignored files (e.g. build outputs, `node_modules`). Sensitive files (such as `.env`) are always filtered out.

Good patterns:
- `*.ts` — all files matching an extension, at any depth below the search root (a bare pattern without `/` matches recursively)
- `src/*.ts` — files directly inside `src/` (one level, not recursive)
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `**/*.py` — recursive walk from the search root for an extension
- `*.{ts,tsx}` — brace expansion is supported
- `{src,test}/**/*.ts` — cartesian brace expansion is supported too

Results are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.

Large-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when `include_ignored` is set:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` can produce thousands of results that truncate at the match cap and waste context. Prefer specific subpaths like `node_modules/react/src/**/*.js`.
