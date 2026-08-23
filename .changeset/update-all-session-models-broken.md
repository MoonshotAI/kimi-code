---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Fix /update-all-session-models: the bulk apply could no-op in the UI and crash the TUI, and the command now ships behind an experiment. The confirm step fired the apply as an unhandled fire-and-forget — any internal error (a throwing session lookup, a reporting failure) escaped as an unhandled rejection, which the CLI turns into an immediate exit to the terminal; every step is now guarded and errors surface as messages instead. The footer model now follows the pick for the current session (including a skipped outcome) and for session-less startup, keeping the old model only on a hard failure. The command is gated behind the new `update-all-session-models` experimental flag (default off, env `KIMI_CODE_EXPERIMENTAL_UPDATE_ALL_SESSION_MODELS`, registered on both engines, toggle via /experiments) — mirroring the compaction-model gate.
