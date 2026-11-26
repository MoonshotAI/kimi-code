---
"@moonshot-ai/agent-core-v2": patch
---

Relative `extra_skill_dirs` entries now resolve against the project root of the primary directory, the working directory and every shared additional directory, primary first, instead of only the working directory, so their skills and skill roots appear for every directory of a multi-directory workspace; the extra source reloads when the workspace directory set changes while extra dirs are configured, and source changes that arrive together are reloaded and merged once, so listeners see the final catalog on the first change event. Explicit skill dirs keep resolving against the working directory only.
