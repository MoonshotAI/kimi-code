---
'@moonshot-ai/agent-core-v2': patch
---

Record each tool call's position in the assistant message in the session journal, and restore a step's tool calls and their results in that order. A tool call was journaled when it started or, if it never started, when its result arrived, and a restored step kept that order. So a parallel batch in which a permission rule denied one call came back reordered, and the first request after a restart or `/reload` broke the prompt cache prefix from that step on. Sessions written by older versions are restored as before.
