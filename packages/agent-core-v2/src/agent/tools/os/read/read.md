Read a text file from the local filesystem.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use `Grep` only when the task is to search for unknown content or locations.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Returns up to ${MAX_LINES} lines or ${MAX_BYTES_KB} KB per call, whichever comes first; lines longer than ${MAX_LINE_LENGTH} chars are truncated mid-line.
- Page larger files with `line_offset` (1-based start line) and `n_lines`. Omit `n_lines` to read up to the ${MAX_LINES}-line cap.
- Sensitive files (`.env` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: `.env.example` / `.env.sample` / `.env.template` and public SSH keys such as `id_rsa.pub` read normally.
- Only UTF-8 text files can be read. Non-UTF-8 encodings, binary files, and files containing NUL bytes are refused; use `ReadMediaFile` for images or video, and Bash or an MCP tool for other binary formats.
- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed ${MAX_LINES}.
- Output format: `<line-number>\t<content>` per line.
- A `<system>...</system>` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.
- Pure CRLF files are displayed with LF line endings; `Edit` matches this output and preserves CRLF when writing back.
- Mixed or lone carriage-return line endings are shown as `\r` and require exact `Edit.old_string` escapes.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.
