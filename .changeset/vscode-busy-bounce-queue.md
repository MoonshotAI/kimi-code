---
"kimi-code": patch
---

Fix prompts vanishing when sent while the session is busy with a turn the chat lost track of (e.g. a live turn after a window reload). The send used to be rejected with "A message is being sent." and the text was parked invisibly until the other turn ended; a busy bounce now moves the message into the queue so it sends when the running turn finishes, and any other send that fails before its turn starts immediately restores the text into the composer.
