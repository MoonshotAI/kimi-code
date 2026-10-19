Find files by glob pattern, sorted by modification time (most recent first).

Powered by ripgrep. Respects `.gitignore`, `.ignore`, and `.rgignore` by default — set `include_ignored` to also match ignored files (e.g. build outputs, `node_modules`). Sensitive files (such as `.env`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).

Good patterns:
- `*.ts` — all files matching an extension, at any depth below the search root (a bare pattern without `/` matches recursively)
- `src/*.ts` — files directly inside `src/` (one level, not recursive)
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `**/*.py` — recursive walk from the search root for an extension
- `*.{ts,tsx}` — brace expansion is supported
- `{src,test}/**/*.ts` — cartesian brace expansion is supported too

Results default to 100 matching paths. Use `offset` (default 0) and `head_limit` (default 100) to page through results. When more matches are available, the result gives the next offset; keep the other search arguments unchanged. Set `head_limit=0` to remove the match-count limit. Pages still stay within the character retention limit, including notices: when it is reached, only complete paths are returned, with the next offset for continuation. Large pages are saved to a file with a path for Read.

Each call searches the current filesystem again; pagination is not a snapshot, and file changes can shift results between pages. To collect a large list, use `head_limit=0`, read any saved output, and follow continuation offsets if the character limit is reached. Search timeouts, traversal errors, and output capture limits can still produce partial results; the result reports these limits, and pagination cannot recover paths that were never collected. Narrow the search and retry when it is incomplete.

Large-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when `include_ignored` is set:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` can produce thousands of results and waste search time and context. Prefer specific subpaths like `node_modules/react/src/**/*.js` unless you need a complete listing.
