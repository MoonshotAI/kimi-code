---
"@moonshot-ai/kimi-code": minor
---

Store OAuth credentials in the operating system keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service) when available, keeping the plaintext files in sync for compatibility; the `credentials_store` config key (`auto` / `keyring` / `file`) controls the behavior, and the plaintext file store remains the fallback when the keychain is unavailable.
