Create, append to, or replace a file entirely. For incremental changes to an existing file, use Edit.

- Don't create documentation files (write-ups, READMEs, summaries) unless the user, a project instruction, or an active mode calls for one.
- Read an existing file before overwriting it.
- Content is written literally, including its line endings; don't include Read's line-number prefixes.
- For new content too large for one call, write the first chunk, then append the rest. Never chunk Write to modify an existing file.
