---
"@moonshot-ai/kimi-code": patch
---

Fix permission rule argument patterns such as Bash(rm -rf*) not matching commands, URLs, or search text that contain slashes or dot segments. Patterns negated with `!` now exclude those subjects as well.
