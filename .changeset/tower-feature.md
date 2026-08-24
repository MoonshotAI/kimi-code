---
"@moonshot-ai/kimi-code": minor
---

Tower mode is Kimi Code's experimental multi-agent collaboration mode. Once enabled with `/tower on`, you can hand off research, development, or verification tasks at any time, and orchestration begins right away: agents work in parallel, each in its own isolated git worktree; an independent reviewer agent examines every change, and only approved work is merged into your chosen branch — with a summary reported back when done. Task boundaries, reviews, and merge order are enforced by tooling rather than prompts alone, so tasks never interfere with one another. Everything is logged and auditable, and you can adjust requirements at any point while work is underway.
