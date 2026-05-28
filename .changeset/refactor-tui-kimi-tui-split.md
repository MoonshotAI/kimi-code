---
"@moonshot-ai/kimi-code": patch
---

Refactor TUI: split the `kimi-tui.ts` God-class into a thin host plus focused controllers (auth-flow, editor-keyboard, session-event-handler, session-replay, streaming-ui, tasks-browser) and per-domain slash-command modules (auth, config, info, plugins, prompts, session). Pure internal refactor — no user-visible behavior changes.
