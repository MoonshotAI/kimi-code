---
"@moonshot-ai/kimi-code": patch
---

Add Mermaid diagram rendering to the web chat. Fenced `mermaid` blocks in assistant responses now render as diagrams. KaTeX math and Mermaid diagram parsing also run in Web Workers to keep the UI responsive during live streaming.
