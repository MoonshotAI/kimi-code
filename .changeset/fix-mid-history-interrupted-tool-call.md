---
"@moonshot-ai/kimi-code": patch
---

Fix resume not realigning a tool call that was interrupted mid-history. The synthetic interrupted result is now closed in place at the next step boundary, so later turns and deferred messages keep their recorded order instead of only the trailing exchange being repaired. The `/messages` wire transcript reducer mirrors the same closure so its folded length stays aligned with live history, preventing the later turn from being duplicated/reordered.
