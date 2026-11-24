---
'@moonshot-ai/kap-server': patch
---

Append the content parts of an open step to the conversation without scanning the items already in its turn, so folding a step with many content blocks no longer takes quadratic time on the server's main thread.
