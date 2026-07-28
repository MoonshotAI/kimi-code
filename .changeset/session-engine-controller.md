---
"@moonshot-ai/kimi-code": patch
---

Extract the session-owned engine integration into a reusable `SessionEngineController` (client factory + event/approval sinks, dependency-injected so the whole flow is unit-testable without a live engine), and adopt it in the `KIMI_SESSION_ENGINE=1` print pilot. The controller owns the engine `SessionClient`, translates engine wire events onto the SDK `Event` union, bridges the tool-approval gate onto a host yes/no prompt, and exposes an `onRawEvent` tap for engine-only signals the translator drops (e.g. `session.goal.updated`). This is the reusable seam for a future thin-client host; the interactive TUI deliberately stays on the proven `runTurnOverride` path (v1/v2), where Rust already drives turns and the override's `dispatchEvent` already emits the SDK events the TUI renders — no parallel TUI integration is introduced.
