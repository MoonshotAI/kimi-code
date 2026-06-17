---
"@moonshot-ai/kimi-code": patch
---

Redesign the web OAuth login dialog: lead with a single "Authorize in browser" button that opens the verification link with the device code already embedded, demote manual code entry to a clearly secondary fallback, and drop the duplicate open-browser and cancel controls so the order of steps is unambiguous.
