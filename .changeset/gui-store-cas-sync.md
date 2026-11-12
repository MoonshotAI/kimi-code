---
"@moonshot-ai/kimi-code": patch
---

Replace the `/api/v1/gui/store/{getItem,setItem,removeItem,clear,length}` endpoints with versioned `GET` and `PATCH /api/v1/gui/store` plus `event.gui_store.updated` WebSocket broadcasts; the previous per-key endpoints are no longer available.
