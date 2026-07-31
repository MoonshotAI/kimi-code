---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/vis-server": patch
---

feat(vis): show LAN URLs when binding to 0.0.0.0 for remote control

When vis-server binds to 0.0.0.0 or :: (all interfaces), the startup
banner and CLI output now display the actual LAN IP addresses that
other devices on the same network can use to connect. This enables
lan-range remote control from phones, tablets, or other machines.
