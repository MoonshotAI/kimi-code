---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-oauth": minor
---

Store OAuth credentials in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) by default, falling back to the plaintext file store when the keychain is unavailable — unsupported platform, missing/locked backend, native binary not loadable, or `KIMI_DISABLE_KEYRING=1`. Existing plaintext credentials are migrated into the keychain on first read and then deleted, so users stay logged in and the on-disk secret is removed. Set `KIMI_DISABLE_KEYRING=1` to opt out and keep using the plaintext file store.
