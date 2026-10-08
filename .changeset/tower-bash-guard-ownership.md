---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental): the destructive-Bash-command guard now only engages while the tower workspace has a live owner, so sessions that never entered tower mode or already turned it off are no longer blocked; the veto message now names the real escape (turn tower mode off, then remove .tower/comms manually).
