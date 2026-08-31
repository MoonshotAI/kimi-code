---
"@moonshot-ai/kimi-code": minor
---

Store OAuth credentials in the operating system keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service) when available, migrating existing plaintext credentials on first read and falling back to the plaintext file store when the keychain is unavailable.
