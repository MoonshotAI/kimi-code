---
"@moonshot-ai/kimi-code": minor
---

Add environment variables to configure the web search and web fetch services without OAuth login: `KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` and `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY`, each taking priority over the corresponding `[services]` fields in `config.toml`. The `[services.moonshot_fetch]` config section is now also honored by the `kimi web` backend, where it was previously ignored.
