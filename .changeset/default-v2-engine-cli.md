---
"@moonshot-ai/kimi-code": minor
---

Run the CLI surfaces (interactive TUI, `kimi -p`, `kimi doctor`, `kimi acp`, `kimi export`, `kimi provider`) on the agent-core-v2 engine by default, and drop the experimental `kimi acp-v2` command now that `kimi acp` uses the new engine directly. Set `KIMI_CODE_LEGACY_FLAG=1` to fall back to the legacy engine.
