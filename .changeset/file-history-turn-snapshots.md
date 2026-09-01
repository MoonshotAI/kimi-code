---
"@moonshot-ai/kimi-code": minor
---

Add experimental turn-level file snapshots (enable with KIMI_CODE_EXPERIMENTAL_FILE_HISTORY=1): each turn records the files it edits — their content from before the first edit and after the turn ends — keeping the last five editing turns for the thirty most recently active sessions of each workspace.
