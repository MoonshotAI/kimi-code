---
"@moonshot-ai/kimi-code": minor
---

Show available plugin updates in the marketplace. An installed plugin whose marketplace version is newer than the local version now renders an `update <local> → <latest>` badge (and updates in place on Enter); up-to-date plugins show `installed · v<version>`. The marketplace `version` served in dev and written by the CDN build is now stamped from each plugin's manifest so "latest" stays accurate.
