---
"@moonshot-ai/pi-tui": patch
---

Fix janky mouse-wheel scrolling during streaming: render scroll input immediately instead of throttling it, and keep the transcript viewport anchored to the same content when it shrinks mid-turn (fold/trim) so the view no longer snaps to the top.
