Create, append to, or replace a file entirely.

- Missing parent directories are created automatically (like `mkdir(parents=True, exist_ok=True)`).
- Mode defaults to overwrite; append adds content at EOF without adding a newline.
- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.
- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.
- Do not create documentation files (`*.md`) or `README`s unless the user explicitly asks for them.
- Read before overwriting an existing file.
- Write ignores the Read/Edit line-number view. NEVER include line prefixes.
- Write outputs content literally, including supplied line endings: \n stays LF, \r\n stays CRLF.
- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.
