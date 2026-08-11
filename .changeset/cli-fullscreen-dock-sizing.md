---
"@moonshot-ai/kimi-code": patch
---

Fix the fullscreen layout clipping the editor's bottom border (and squeezing other dock chrome) whenever the transcript grew past the screen height: the dock now keeps its intrinsic height and the editor never shrinks below its 3 rows.
