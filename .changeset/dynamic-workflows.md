---
"@moonshot-ai/kimi-code": minor
---

Add experimental dynamic workflows: multi-phase subagent orchestration from user-approved JS scripts, with background runs, progress tracking, cancellation, and project/user-level reuse. Enable with KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1, then run /workflow.

Also add the `/workflow on|off` mode that instructs the agent to propose dynamic workflows for large tasks, dynamic argument autocomplete listing available workflows after `/workflow run`, a `wf` mode badge in the footer, and workflow visibility in the `/tasks` browser.
