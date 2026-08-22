---
"@moonshot-ai/kimi-code": patch
---

Fix ACP prompts with multiple attached files failing as `Internal error: session prompt failed` in Zed and other ACP clients (#1777). Zed and similar orchestrators emit multi-attachment prompts as content blocks separated by whitespace-only text blocks — e.g. `[resource, text(" "), resource, text(" "), text("todo:...")]`. The adapter's `acpBlocksToPromptParts` used to convert each separator into its own `PromptPart`, which the SDK then rejected because per-part validation requires `text.trim().length > 0`. The failure came back as a generic `Internal error: session prompt failed`, with the real cause only in the local session log. Whitespace-only text blocks are now attached to the preceding text-producing part (or dropped when they lead a prompt), preserving the separators inside a valid part instead of standing alone.
