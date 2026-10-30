Read a UTF-8 or UTF-16 text file from the local filesystem, or a `kimi-file://` attachment of this session.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Output is `<line-number>\t<content>` per line. A `<system>` status block may follow; it is not part of the file.
- Results are bounded by `max_chars`: ${DEFAULT_MAX_CHARS} by default, up to ${MAX_CHARS}.
- If the status block reports an incomplete range, continue with its `Next Read` arguments exactly. Do not answer from a partial page when the task requires the remaining content.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed.
