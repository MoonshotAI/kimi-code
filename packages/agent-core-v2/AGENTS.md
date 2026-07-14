# agent-core-v2 Agent Guide

## Use the agent-core-dev skill

All development in this package — adding or modifying a Service, choosing a scope, wiring DI dependencies, writing tests, or porting logic from `packages/agent-core` — must follow the `agent-core-dev` skill (`.agents/skills/agent-core-dev/SKILL.md`). Load it before touching any code here; it is the single source of truth for this package's architecture, conventions, and red lines.

## Do not write comments

Do not write comments beside functions, methods, or statements. The code is the source of truth for how it works — name things well instead of narrating them, and delete stale comments instead of updating them. The only exception is the mandatory top-of-file `/** */` header block, whose format the skill defines.
