Read media content from a file.

The path may be a `kimi-file://` attachment reference from the current session. Any reported local attachment path belongs to the server; external converters must be able to access that filesystem.

- Read multiple files in parallel when possible.
- After generating or editing media via commands or scripts, read the result back before continuing.
- Use Read for text files and Glob to find files. Maximum size: ${MAX_MEDIA_MEGABYTES}MB.

**Capabilities**
