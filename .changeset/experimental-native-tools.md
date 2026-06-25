---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-native-tools": minor
---

Add a native-tools implementation, providing Rust-backed Read, Write, Edit, Grep, Glob, and Bash tools with automatic fallback to the TypeScript implementations. Enabled by default via the `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS` flag; set `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS=0` to opt out and use the TypeScript originals.
