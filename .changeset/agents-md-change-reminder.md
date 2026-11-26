---
"@moonshot-ai/agent-core-v2": patch
---

The main agent now compares its AGENTS.md files with the last recorded state at the start of every turn, instead of relying only on file watcher events. An AGENTS.md added, changed or removed right before a prompt, while the product was not running, or where file watching is off (remote environments, `[watch] enabled = false`, `KIMI_CODE_WATCH=0`) is now announced in that turn's request; before, the reminder came a turn late or never. The check runs on the same queue as the other snapshot updates, so a file event during it no longer sends the reminder twice. A new session records the AGENTS.md state once on its first turn.
