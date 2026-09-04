---
"@moonshot-ai/kimi-code": patch
---

Collapse finished tool calls in the transcript to two lines: the header names the call (a Bash card carries the command and its line count) and the outcome rows show the output whole when it is three lines or fewer, otherwise the command's last output line, a Grep/Glob path sample, or a tool's first output line; the full output and a Read group's file list appear after `Ctrl+O`. Failed calls keep their output preview, and Edit/Write previews are unchanged. A Grep card's chip now reads `N files` or `N matches across K files` according to its output mode, and the tools' pagination and empty-result notices no longer count as results. While the recent turns hold tool output that `Ctrl+O` would reveal or hide, the footer shows `ctrl+o expand` or `ctrl+o collapse`.
