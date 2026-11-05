Perform exact replacements in existing files.

- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context.
- Multiple Edit calls may run in one response only when they do not target the same file.
- Inspect the file again before consecutive edits to the same file; a previous Edit can invalidate a later Edit's `old_string`.
