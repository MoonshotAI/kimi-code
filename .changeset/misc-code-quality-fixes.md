---
"@moonshot-ai/kimi-code": patch
---

Fix a syntax error in the minidb query store test, prevent plugin directory leaks on removal, replace JSON-serialization of config records with structuredClone, close a registry-removal window in WebSocket connection teardown, add workspace path traversal guards in transcript reads, and route hook failures through the event bus instead of silent console output.