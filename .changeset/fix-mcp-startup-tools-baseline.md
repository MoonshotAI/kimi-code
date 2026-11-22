---
'@moonshot-ai/agent-core-v2': patch
---

Wait for initial MCP discovery to settle before pinning the agent loop's tool baseline, so tools from slow-starting MCP servers stay visible for the whole session. Loop start is now the single point that waits for MCP readiness; the per-step and per-tool-call waits are removed.
