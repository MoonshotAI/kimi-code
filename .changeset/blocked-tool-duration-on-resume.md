---
'@moonshot-ai/agent-core-v2': patch
---

Record a tool's duration in the session journal only when the tool actually ran. A tool that a permission rule denied, or that a stop cut off before it started, was journaled with a duration of 0, so a resumed session showed it to the model with a `Wall time` line it never had live and broke the prompt cache prefix.
