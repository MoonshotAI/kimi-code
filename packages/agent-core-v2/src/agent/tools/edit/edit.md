Perform exact replacements in existing files.

- Drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context.
- Multiple Edit calls may run in one response only when they do not target the same file.
- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.
- A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.
- For pure CRLF files, Read shows LF; use LF in `old_string` and `new_string`, and Edit writes CRLF back.
- A leading UTF-8 byte order mark (BOM) is kept in the file but never shown in content; match and replace without it, and Edit writes it back.
- For mixed endings or lone carriage returns, Read shows carriage returns as \r; include actual \r escapes in those positions.
