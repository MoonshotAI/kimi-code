---
"@moonshot-ai/kimi-code": patch
---

Fix a crash where interrupting an AgentSwarm with Esc killed the whole process with exit 1. Tool aborts now carry the user-cancellation reason so an interrupted swarm resolves per-subagent "aborted" results instead of rejecting, and the swarm cleanup no longer leaves a floating promise that could turn any batch failure into an unhandled rejection.
