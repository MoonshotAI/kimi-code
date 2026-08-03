---
"@moonshot-ai/kimi-code": minor
---

Add built-in product capabilities (`kimi-cu`, `kimi-webbridge`) to the local server: a closed registry owns layered readiness detection and idempotent install orchestration — binary runtimes from fixed official CDN URLs plus agent wiring through the plugin service — exposed as `GET /api/v1/capabilities`, `GET /api/v1/capabilities/{id}`, and `POST /api/v1/capabilities/{id}:install` with client-polled progress. The `/plugins` panel lists both as official entries injected client-side (not served by the remote catalog), so their visibility is bound to the client version; install them from the Official tab.
