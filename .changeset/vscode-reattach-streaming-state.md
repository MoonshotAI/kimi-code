---
"kimi-code": patch
---

Keep the composer in streaming state when a chat is opened while its session has a live turn (e.g. a turn started in another view, or one still running when the window reloaded). The session history reply now carries a `turn_active` marker when the runtime is busy, and the store honors it — new input enqueues and is sent when the running turn finishes, instead of taking the send path and bouncing off the busy runtime.
