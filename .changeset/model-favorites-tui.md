---
"@moonshot-ai/kimi-code": minor
---

Add favorite models with quick rotation: the `/model` picker gains a Favorites tab (first tab, add-order) listing only favorited models, every list row shows a ★ for favorites, and Alt+M toggles the favorite state of the highlighted model from inside the picker. Alt+M in the editor rotates the session straight to the next favorite model — no dialog, wrapping around, session-only (the persisted default model is untouched). Favorites persist in tui.toml (`favorite_models`) and update the picker live; models missing from the catalog are skipped gracefully. (Alt+M rather than the spec's illustrative Alt+F, which is the editor's cursor-word-right binding.)
