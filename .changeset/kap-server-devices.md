---
"@moonshot-ai/kap-server": minor
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/remote-control": minor
---

Rename SSH hosts to devices across the KAP routes, events, and config section, and add Kimi account devices reached through the Remote Control relay. SSH hosts saved in the `[hosts]` config section move to `[devices]` when the server starts. Meta now reports the device id and device API level; an SSH device on an earlier release still connects with its identity unknown, and a machine that is already added, or is this machine, is reported as a duplicate instead of being listed twice.
