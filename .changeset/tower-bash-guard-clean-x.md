---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental): `git clean -fd` without -x/-X is no longer blocked at the tower main checkout, because .tower/ is git-ignored and such a clean cannot touch it; only forced cleans carrying -x/-X are still vetoed when their scope covers the tower protocol state.
