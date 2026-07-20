---
"@moonshot-ai/kimi-code": patch
---

Windows: stop flashing a console window when `kimi web` opens the browser and when the web UI launches files/editors. `openUrl`, `launchDetached`, and the win32 `where` probe now pass `windowsHide: true`, matching the earlier fixes for spawned commands (#957), the background updater (#1336), and hooks (#1466).
