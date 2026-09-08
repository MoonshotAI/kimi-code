Read a text file from the local filesystem.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use `Grep` only when the task is to search for unknown content or locations.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Returns complete lines within `max_chars`, including line numbers and the status block. The configured default is ${DEFAULT_MAX_CHARS} characters; calls can request up to ${MAX_CHARS}. Characters use JavaScript string length, not UTF-8 bytes or tokens. Read results are not spilled or shortened again by the general tool-output limit.
- Omit `n_lines` to read toward the end of the file. There is no fixed line-count cap. When the task requires the full text of a large file, request a larger `max_chars`, up to ${MAX_CHARS}, in the first call.
- Page larger files with `line_offset` (1-based start line) and `n_lines`. If the result is incomplete, copy the `Next Read` arguments in the status block to continue without gaps or overlaps. Do not answer from a partial page when the task requires the remaining content.
- Long lines are returned whole. If a single line cannot fit, increase `max_chars` or use Bash to extract a smaller character range from that line; Read never silently drops the end of a line.
- Kimi Code agent event logs (`wire.jsonl` under the sessions directory) follow the same character budget; read one record at a time with `n_lines=1` after locating the line with Grep, and increase `max_chars` for longer records.
- Sensitive files (`.env` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: `.env.example` / `.env.sample` / `.env.template` and public SSH keys such as `id_rsa.pub` read normally.
- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and transcoded to UTF-8 for display; the status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with `iconv`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.
- Negative `line_offset` reads from the end of the file (for example, -100 reads the last 100 lines). If the requested tail range exceeds the character budget, the newest lines in that range are returned first; `Next Read` covers the omitted earlier range.
- Output format: `<line-number>\t<content>` per line.
- A `<system>...</system>` status block is appended after the file content. It reports the actual returned range, total lines, effective character budget, whether the requested range is complete, and whether EOF was reached. The block is not part of the file itself.
- Pure CRLF files are displayed with LF line endings; `Edit` matches this output and preserves CRLF when writing back.
- Mixed or lone carriage-return line endings are shown as `\r` and require exact `Edit.old_string` escapes.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.
