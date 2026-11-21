---
"@moonshot-ai/agent-core-v2": minor
---

Resolve implicit projects by repository. A directory whose own implicit project already has sessions (alias buckets and archived sessions included) keeps that project; otherwise a directory inside a git repository joins the implicit project of the repository's main checkout, unless the main checkout is the home directory or one of its ancestors, and any other directory gets its own implicit project as before. The main checkout is located from disk without running git, starting from the nearest `.git` entry: a linked worktree joins its main checkout only when its back pointer and common directory match, and a forged or unreadable `.git` keeps the directory in its own project. Every entry that creates implicit projects goes through this resolver, read-only directory lookups no longer register a project, and session index lines written by this version no longer create projects or aliases of their own when the index is merged.
