---
"kimi-code-app": patch
---

Fix quitting, or changing a remote environment, taking about five extra seconds after a git, gh or ripgrep command failed to start on that host, for example when gh is not installed there.
