---
"@moonshot-ai/kimi-code": minor
---

Store OAuth credentials in the operating system keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service) when available, keeping the plaintext files in sync for compatibility; set `credentials_store` in `config.toml` (`auto` / `keyring` / `file`) to control the behavior, or `KIMI_DISABLE_KEYRING=1` to force the file store.
