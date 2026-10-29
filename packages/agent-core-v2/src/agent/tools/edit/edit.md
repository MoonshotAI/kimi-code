Perform exact replacements in existing files. Use it for incremental changes rather than `Write` or `sed`.

- Match file content only: drop Read's line-number prefix and tab.
- `old_string` must be unique unless `replace_all` is set.
- Edits apply in order to the file's current content, so a later `old_string` must still match after your earlier edits. Multiple Edit calls in one response must target different files.
