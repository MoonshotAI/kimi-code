---
"@moonshot-ai/kimi-code": minor
---

Add an optional OS-level sandbox for Bash command execution and file-tool path policies, configured through a new `[sandbox]` section. On Linux commands run under bubblewrap, on macOS under sandbox-exec: reads of configured sensitive paths are masked, writes are restricted to the workspace roots (workspace-write mode) or tmpdir (read-only mode), and the network is disabled by default. Sandboxed commands skip permission prompts by default (`auto_allow_sandboxed_bash`), sandbox filesystem denies (deny_read / deny_write / sensitive files) are hard boundaries evaluated before auto-approvals, and file tools reading or writing outside the workspace fall back to an approval prompt. When no sandbox backend is available the CLI warns once and runs unsandboxed; `require = true` switches to fail-closed. See `docs/en/configuration/sandbox.md` for the full reference.
