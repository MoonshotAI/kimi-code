Read a UTF-8 or UTF-16 text file from the local filesystem, or a `kimi-file://` attachment of this session.

Read known paths directly; a missing or invalid path just returns an error.

- Output is `<line-number>\t<content>` per line, followed by a `<system>` status block that is not part of the file.
- Results are bounded by `max_chars`: ${DEFAULT_MAX_CHARS} by default, up to ${MAX_CHARS}. What you read stays in context and is sent again with every later request until compaction, so a large read keeps costing tokens.
- When the status block reports an incomplete range, its `Next Read` arguments continue exactly where it stopped.
- A successful `Edit` or `Write` result is reliable; there is no need to re-read the file to confirm it.
