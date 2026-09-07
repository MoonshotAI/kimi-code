---
"@moonshot-ai/kimi-code": patch
---

Add environment variables for the `[task]` background and print-mode settings: `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S`, `KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE`, `KIMI_CODE_BACKGROUND_PRINT_WAIT_CEILING_S`, and `KIMI_CODE_BACKGROUND_PRINT_MAX_TURNS`, each taking priority over `config.toml`.
