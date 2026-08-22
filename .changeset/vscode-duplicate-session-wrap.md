---
"kimi-code": patch
---

Fix duplicated, interleaved assistant output (e.g. "TheThe roaring roaring") when two views race to open the same session. A concurrent open/attach used to wrap the session in a second `SessionRuntime` whose event subscription was never cleaned up, so every streamed part was broadcast twice; the later open now reuses the existing runtime.
