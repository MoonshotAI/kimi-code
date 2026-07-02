---
"@moonshot-ai/pi-tui": patch
---

Add history hooks to the editor so hosts can filter entries (`setHistoryFilter`), decorate recalled entries (`onRecall`), and save and restore their own state alongside the history draft (`onHistoryDraftSave` / `onHistoryDraftRestore`).
