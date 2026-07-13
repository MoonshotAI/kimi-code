---
"@moonshot-ai/kap-server": patch
---

Report the live (measured + estimated) context size in the v2 server's v1-compatible status stream instead of the measured-only count, which read 0 until the first model response of a session completed and could dip mid-turn while the context was being rewritten.
