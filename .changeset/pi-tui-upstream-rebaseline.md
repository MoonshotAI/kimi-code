---
"@moonshot-ai/pi-tui": patch
---

Re-baseline the fork on upstream pi-tui v0.84.1. The upstream renderer is now split into main-screen and alternate-screen implementations (the `TUI` class is now an interface implemented by `TuiMainScreen` and `TuiAltScreen`), and the Markdown component gained opt-out LaTeX math rendering. All local patches are retained: narrow-terminal hardening, processed-line render caching, editor history hooks, the paste-burst fallback, and multi-root `@` completion. `Editor.setText` accepts a `preservePasteRegistry` option so subclasses can replace text without orphaning live paste markers (upstream resets the registry on every `setText`).
