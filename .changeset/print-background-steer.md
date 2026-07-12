---
"@moonshot-ai/kimi-code": patch
---

Add a print-mode background policy that lets `kimi -p` stay alive across background-task completions so the main agent can be steered into follow-up turns. Set `[background].print_background_mode = "steer"` to enable it.
