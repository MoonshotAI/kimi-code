---
"@moonshot-ai/kimi-code": patch
---

Validate ssh and docker remote environment launchers before connecting: a host or container name starting with `-` is rejected instead of being parsed as client options, and a `remoteBin` with shell metacharacters now runs as a literal path on the target.
