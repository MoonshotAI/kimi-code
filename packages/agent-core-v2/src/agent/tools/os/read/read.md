Read a text file, or a `kimi-file://` attachment of this session.

- A missing path, a directory, or a binary file returns an error instead of content.
- Output is `<line-number>\t<content>` per line. A `<system>` block may follow; it is not part of the file.
- Long files come back in pages; an incomplete page ends with `Next Read` arguments that continue exactly where it stopped.
- What you read stays in context and is sent again with every later request, so read only the part you need when you know where it is.
