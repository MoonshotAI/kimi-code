---
"@moonshot-ai/kimi-code": minor
---

Surface the dedicated compaction model in the TUI: add a `/compaction-model` slash command that picks and persists `[compaction_model]` (mirroring `/visual-model`), and show which model performs compaction — the in-progress indicator now reads "Compacting context using <model>..." for manual and automatic compaction, in the terminal TUI, the ACP adapter, and the VS Code extension. The `compaction.started` event carries `model` and `model_display`, and `/visual-model`, `/substitute-model`, and `/compaction-model` now read their configured value back on the v2 engine.