---
"@moonshot-ai/kimi-code": patch
---

Collapse finished tool calls in the transcript to two lines: the header names the call (a Bash card carries the command and its line count) and one outcome row shows the command's last output line, a Grep/Glob path sample, or a tool's first output line; the full output and a Read group's file list appear after `Ctrl+O`. Failed calls keep their output preview, and Edit/Write previews are unchanged.
