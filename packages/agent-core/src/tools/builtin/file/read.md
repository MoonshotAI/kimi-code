Read a file from the local filesystem. Text files return numbered lines; image and video files return media content you can view directly, subject to the model capabilities listed at the end.

If the user provides a concrete file path, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files/directories matching a pattern. Use `Grep` only when the task is to search for unknown content or locations.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Text files return up to {{ MAX_LINES }} lines or {{ MAX_BYTES_KB }} KB per call, whichever comes first; lines longer than {{ MAX_LINE_LENGTH }} chars are truncated mid-line.
- Page larger text files with `line_offset` (1-based start line) and `n_lines`. Omit `n_lines` to read up to the {{ MAX_LINES }}-line cap.
- Sensitive files (`.env` files, credential stores, SSH keys, and similar secrets) are refused to protect secrets; do not attempt to read them.
- Only UTF-8 text files can be read as text. Non-UTF-8 encodings and binary files that are not images or videos are refused; use Bash or an MCP tool for those formats.
- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed {{ MAX_LINES }}.
- Text output format: `<line-number>\t<content>` per line.
- A `<system>...</system>` status block is appended after the file content for text reads; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.
- Pure CRLF files are displayed with LF line endings; `Edit` matches this output and preserves CRLF when writing back.
- Mixed or lone carriage-return line endings are shown as `\r` and require exact `Edit.old_string` escapes.
- Image and video files are detected by extension and magic bytes and returned as media content; `line_offset` and `n_lines` are ignored for them. The maximum media file size is {{ MAX_MEDIA_MEGABYTES }}MB.
- Media content is preceded by a `<system>` block summarizing the mime type, byte size and, for images, the original pixel dimensions. When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size.
- After generating or editing an image or video via commands or scripts, read the result back immediately before continuing.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.
