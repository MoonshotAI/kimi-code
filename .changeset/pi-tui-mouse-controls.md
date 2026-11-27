---
"@moonshot-ai/pi-tui": minor
---

Add optional host controls for Alt-wheel acceleration and right-click selection copying, including unverified clipboard delivery results, ordered asynchronous writes, and second-click paste after pending copies; successful copies clear only their original selection and failed copies retain it. Expose a public input-dispatch entry that reuses input listeners and the focused-component pipeline, so application right-click clipboard paste replaces selections through the normal input path.
