---
"@moonshot-ai/acp-server": patch
---

While a tool runs, the output it prints is now sent to the editor as `tool_call_update` text content, instead of only with the tool result: the latest 50,000 characters, starting with `[…truncated]` once earlier output was cut, at most once every 250 ms for each tool call. A command running in an editor terminal keeps showing that terminal, and the card is no longer updated after the tool result, including for a command moved to the background.
