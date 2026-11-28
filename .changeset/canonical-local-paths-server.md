---
"@moonshot-ai/kap-server": patch
---

Report local directories with forward slashes on Windows and without trailing separators, including the `cwd` and `environment_cwd` of sessions pinned to a worktree or subdirectory, workspace `root` and `additional_dirs`, and the directory in duplicate-folder errors. `POST /sessions` compares `cwd`, `workspace_root` and the workspace root as directories, so spellings that differ only in separators, Windows letter case or a trailing separator are no longer rejected as conflicting or outside the workspace, and such a spelling of a removed workspace root returns 40409 like the stored spelling does. The KAP guide documents the path form.
