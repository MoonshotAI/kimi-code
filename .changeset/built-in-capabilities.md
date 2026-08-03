---
"@moonshot-ai/kimi-code": minor
---

Add built-in product capabilities (`kimi-cu`, `kimi-webbridge`) to the local server: a closed registry owns layered readiness detection and idempotent install orchestration — binary runtimes from fixed official CDN URLs plus agent wiring installed from plugin copies bundled into the client release — exposed as `GET /api/v1/capabilities`, `GET /api/v1/capabilities/{id}`, and `POST /api/v1/capabilities/{id}:install` with client-polled progress. Install them from the Built-in section of the `/plugins` panel's Official tab.
