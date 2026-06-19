Two actions available:

**Search** (`action: "search"`): Find relevant skills using natural language.
Describe what you need in plain language — the search uses your semantic intent, not just keywords.
Returns compact candidates with match reasons for you to evaluate.

Examples:
- User says "help me write e2e tests" → `{"action":"search","query":"end-to-end testing playwright"}`
- User says "deploy this to AWS" → `{"action":"search","query":"deployment infrastructure AWS"}`
- User says "fix the slow database queries" → `{"action":"search","query":"database performance optimization"}`

You are the semantic judge — the search returns candidates, YOU decide relevance based on the user's full context.

**Load** (`action: "load"`, default): Load a skill's full instructions into context.
Only call after you know the exact skill name (from search results or prior knowledge).
BLOCKING REQUIREMENT: when a skill matches the user's request, you MUST load it (not free-form text).

Workflow rule:
1. At the beginning of a new task (and at the start of each major phase in Ultrawork), call `Skill` with `action:"search"` using natural language describing the task.
2. Review the compact candidates and match reasons.
3. Load the best matching skill with `action:"load"` and the exact `skill` name.
4. Follow the loaded skill instructions before using other tools.

Do NOT guess skill names — always search first.
Do NOT call the same skill repeatedly inside one turn — recursive depth is capped at {{ MAX_SKILL_QUERY_DEPTH }}.
