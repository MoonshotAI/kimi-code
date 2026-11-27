---
"@moonshot-ai/agent-core-v2": patch
---

Store local directories in one form: project roots, the work directory of a new local session and the directory it is pinned to drop trailing separators and use forward slashes on Windows. Project catalogs, session metadata, session index rows and scan cache entries, and resumed or forked sessions written by older versions are read in the same form. On Windows this also changes the directory that hooks, MCP servers and the model see for managed projects, projects outside a git repository and sessions pinned to a worktree or subdirectory. Project ids are unchanged, and remote sessions keep their paths as given.
