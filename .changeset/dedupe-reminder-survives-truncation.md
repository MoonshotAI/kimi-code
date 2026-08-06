---
"@moonshot-ai/kimi-code": patch
---

Fix repeat-tool-call reminders never reaching the model for oversized tool results. The dedupe reminder was appended at the end of the tool output, but the >50K offload path keeps only a 2K head preview, so the reminder was silently cut off exactly in the large-output scenarios where repeat loops are most likely. Reminders are now prepended to the result output so they survive truncation. Covers both the v1 (`agent-core`) and v2 (`agent-core-v2`) engines.
