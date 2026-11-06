Perform exact replacements in existing files.

- Drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context.
- Set `allow_large_delete=true` only when intentionally deleting 3 or more lines with an empty or whitespace-only `new_string`, including cumulative multi-line `replace_all` matches. Prefer replacing with the intended content.
