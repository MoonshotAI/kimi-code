---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/kimi-code": minor
---

Support custom agents defined as Markdown files with frontmatter — replace or append the system prompt, allow/deny tools — with `--agent` / `--agent-file` selecting the main agent.

Directory-discovered files now require `override: true` before replacing a same-name built-in Agent, while `--agent-file` remains an explicit override intent. Agent capability descriptions show the effective tool set after applying `disallowedTools`.

The bound agent is the session's identity: once bound it cannot be switched (`profile.already_bound`), and re-selecting the same agent on resume is a no-op. Note: a session recorded with a `disallowedTools` gate loses that gate when replayed by an older build (downgrade limitation).
