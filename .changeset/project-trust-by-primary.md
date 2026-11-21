---
"@moonshot-ai/agent-core-v2": minor
---

Trust a project through its primary directory alone. A project is trusted exactly when its primary directory has a trust record, and that trust covers the whole project scope: the primary directory and registered directories with their subtrees, plus the other checkouts of the same repository. Trust records of additional directories, `local.toml` directories, `--add-dir` directories and other projects' directories no longer make a project trusted, and changing a managed project's primary directory carries its trust to the new primary; untrusting still clears the records of the primary directory and every additional directory. Project scope is judged by real paths, so a symlink inside a project that points outside it is not part of the scope. The MCP registry lists servers by the project's trust and the session's anchor, so a `.kimi-code/mcp.json` in a subdirectory that is not a checkout root is no longer listed.
