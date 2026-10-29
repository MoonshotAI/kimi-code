Find files by glob pattern, sorted by modification time (most recent first). Powered by ripgrep.

- Matches are files only; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).
- A pattern without `/` matches at any depth (`*.ts`); `src/*.ts` matches only directly inside `src/`, and `src/**/*.ts` matches beneath it. Brace expansion works: `*.{ts,tsx}`, `{src,test}/**/*.ts`.
- Results are paginated: continue with the returned offset and otherwise unchanged arguments.
- Dependency and build-output directories, especially with `include_ignored`, can return thousands of paths that all land in your context.
