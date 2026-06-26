---
"@moonshot-ai/agent-core": patch
---

fix: preserve symlinks in atomicWrite to prevent config.toml symlink breakage

When config.toml is a symlink (e.g., pointing to iCloud), atomicWrite's rename() was replacing the symlink itself instead of writing through it. This fix resolves symlinks before rename, preserving the symlink.
