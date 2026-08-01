---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Refactor `assertAllowed` to throw a coded `Error2` instead of a raw `Error` when a path escapes the workspace. This allows the terminal routing code to elegantly fold the error handling into the standard `isError2` switch block.
