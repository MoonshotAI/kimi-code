Read media content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag is given before the file content; it summarizes the mime type, byte size and, for images, the original pixel dimensions. When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size. After generating or editing media via commands or scripts, read the result back before continuing.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read image or video files. To read text files, use the Read tool. To list directories, use `ls` via Bash for a known directory, or Glob for pattern search.
- If the file doesn't exist or path is invalid, an error will be returned.
- The maximum size that can be read is {{ MAX_MEDIA_MEGABYTES }}MB. An error will be returned if the file is larger than this limit.
- When analyzing video files, prefer using ReadMediaFile directly rather than writing Python scripts to extract frames. The model can directly view and understand the video content returned by this tool.

**Capabilities**