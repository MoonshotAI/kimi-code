Search and manage persistent memory across sessions.

Memory files are markdown documents stored under `~/.kimi-code/memory/`, organized by scope:
- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)
- **project** — project-specific knowledge tied to the current working directory
- **session** — session-specific notes and context

## Actions

### `search` (default)
Full-text search over all memory entries. Returns matching snippets with scope and relevance score.
```
Memory({ action: "search", query: "authentication pattern" })
```

### `read`
Read a specific memory file by its relative path.
```
Memory({ action: "read", path: "global/auth-pattern.md" })
```

### `write`
Create or update a memory file. The `scope` determines where it lives:
- `global` — stored at `~/.kimi-code/memory/global/`
- `project` — stored at `~/.kimi-code/memory/projects/<projectId>/`
- `session` — stored at `~/.kimi-code/memory/sessions/<sessionId>/`

```
Memory({
  action: "write",
  scope: "project",
  path: "auth-pattern",
  content: "# Authentication Pattern\n\nUse JWT with refresh tokens..."
})
```

### `list`
List all memory files, optionally filtered by scope.
```
Memory({ action: "list", scope: "global" })
```

### `delete`
Delete a memory file by its relative path.
```
Memory({ action: "delete", path: "global/old-note.md" })
```

## When to use

- **Before starting a task** — search memory for relevant context from past sessions
- **After learning something important** — write it to memory for future reference
- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it
- **When debugging** — search for similar past issues and their resolutions

Memory persists across sessions and projects. Use it to build up institutional knowledge.
