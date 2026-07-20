---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Add a `subagents` field to custom agent files: an allowlist of sub-agent types the agent may delegate to, surfaced in the `Agent` tool's type list and enforced again before `Agent` / `AgentSwarm` dispatch (resuming an existing sub-agent stays exempt). Set `subagents: explore, plan` in the agent-file frontmatter (v2 engine only).
