Two actions available:

**Search** (`action: "search"`): Find relevant skills by keywords. Returns ranked results.
Use this when you need to discover skills that match the user's request.
Example: user says "help me write e2e tests" → `{"action":"search","query":"e2e test playwright"}`

**Load** (`action: "load"`, default): Load a skill's full instructions into context.
Only call after you know the exact skill name (from search results or the skill listing).
BLOCKING REQUIREMENT: when a skill matches the user's request, you MUST load it (not free-form text).

Do NOT call the same skill repeatedly inside one turn — recursive depth is capped at {{ MAX_SKILL_QUERY_DEPTH }}.
