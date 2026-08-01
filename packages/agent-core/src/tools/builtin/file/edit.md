Perform exact replacements in existing files.

- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash `sed`.
- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed `old_string`.
- Take `old_string` and `new_string` from the Read output view.
- Drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.
- Multiple Edit calls may run in one response only when they do not target the same file.
- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.
- After Edit fails with `old_string not found`, Read the whole file (or a large enough region covering the edit) once before retrying. Do not loop Edit → short 30–50 line Read → Edit.
- Never replace a multi-line span with an empty `new_string` unless you intend to delete it — set `allow_large_delete=true` for that intentional deletion. Prefer replacing with the real new content.
- A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.
- For pure CRLF files, Read shows LF; use LF in `old_string` and `new_string`, and Edit writes CRLF back.
- For mixed endings or lone carriage returns, Read shows carriage returns as \r; include actual \r escapes in those positions.
