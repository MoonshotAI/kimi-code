---
"@moonshot-ai/kimi-code": patch
---

feat(ci): publish plugin marketplace on release

- Add `build:plugin-marketplace` step to the release workflow
- Upload plugin marketplace artifacts as GitHub Release assets
- Make `build-plugin-marketplace-cdn` script skip missing sources gracefully
