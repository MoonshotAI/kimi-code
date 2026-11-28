---
"@moonshot-ai/agent-core-v2": patch
---

Support bootstrapping ripgrep on OpenHarmony arm64 for local and remote environments by downloading the pinned OpenHarmony archive, verifying its SHA-256, and embedding an OpenHarmony self-signature block into the ELF binary. Unsigned cached or PATH ripgrep ELF binaries on OpenHarmony are self-signed into the shared bin directory so they can execute under kernel code-signing enforcement. Remote OpenHarmony installs fall back to the system chmod path when chmod is missing from PATH, and bootstrap failure guidance points to OpenHarmony ripgrep builds.
