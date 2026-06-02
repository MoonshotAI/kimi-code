Find files (and optionally directories) by glob pattern, sorted by modification time (most recent first).

Good patterns:
- `*.ts` — files in the current directory matching an extension
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `**/*.py` — recursive walk from the search root for an extension
- `*.{ts,tsx}` — brace expansion is supported; expanded into `*.ts` and `*.tsx` before walking
- `{src,test}/**/*.ts` — cartesian brace expansion is supported too

Path argument:
- Omit `path` to search the current working directory. Provide an absolute `path` to search another directory, including one outside the workspace.

Results are capped at the first 100 matching paths (walk order, not global modification-time order). If a search would return more, a truncation marker is appended with the count of matches seen so far. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.

Large-directory caveat — avoid recursing into dependency / build output even with an anchor:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` all match technically but
  typically produce thousands of results that truncate at the match cap and waste the caller context.
  Prefer specific subpaths like `node_modules/react/src/**/*.js`.
