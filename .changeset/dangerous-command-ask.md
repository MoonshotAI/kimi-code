---
"@moonshot-ai/kimi-code": patch
---

Block dangerous shell commands such as shutdown, reboot, or rm -rf in Auto mode, and always ask before running them in Manual and YOLO modes; disable the guard with `[permission] dangerous_command_guard = false` or `KIMI_CODE_DANGEROUS_COMMAND_GUARD=false`.
