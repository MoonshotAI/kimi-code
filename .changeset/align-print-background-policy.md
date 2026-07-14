---
"@moonshot-ai/kimi-code": patch
---

Align the print-mode run lifecycle across engines: `print_background_mode` and `print_max_turns` now take effect for `kimi -p` on the experimental engine, with the same exit / drain / steer semantics and defaults as the default engine, and `kimi -p "/goal ..."` now stays alive until the goal reaches a terminal state instead of exiting after the first turn.
