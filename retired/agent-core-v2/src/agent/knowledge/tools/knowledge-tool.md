Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.

The knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.

Sub-commands (pass as the `action` parameter):
- `search`: Find entries relevant to a query, file path, or tags
- `add`: Record a new standard or pitfall discovered during work
- `confirm`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)
- `reject`: Remove an incorrect or outdated entry

When to use:
- After discovering a non-obvious constraint or convention: use `add`
- When the user corrects you and the correction is a reusable rule: use `add`
- When reviewing existing entries: use `search`
- To validate or dismiss auto-learned entries: use `confirm` or `reject`

Do NOT use this tool for:
- General knowledge or facts (only project-specific standards)
- Temporary per-session preferences
- Information already in AGENTS.md (avoid duplication)
