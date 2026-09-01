---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/transcript": patch
---

Stamp cold-rebuilt steer frames with the promptIds paired from prompt.steered records, and flush pending steer/notification frames in arrival order so post-turn heal can no longer drop prompt pairing or misorder frames.
