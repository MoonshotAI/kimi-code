---
"@moonshot-ai/acp-adapter": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/node-sdk": patch
---

Fix ACP-bridged file reads for binary content and line terminators, prevent silent overwrites on append-mode permission errors, and stop subagent events from interfering with parent prompt resolution.
