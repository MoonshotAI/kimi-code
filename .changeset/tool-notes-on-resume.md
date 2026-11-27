---
'@moonshot-ai/agent-core-v2': patch
---

Render a tool result's note the same way after a session is restored as it was sent live. Live, the note follows the output as its own text part; a restored result merged the note into a single-part output with a newline (and turned an empty output into the empty status first), so Write, Edit and other results with a note broke the prompt cache prefix on the first request after a restart or `/reload`.
