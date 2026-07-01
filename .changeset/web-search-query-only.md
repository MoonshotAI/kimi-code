---
"@moonshot-ai/agent-core": patch
"kimi-code-docs": patch
---

WebSearch now sends only the query and returns lightweight result summaries (title, source site, date, URL, snippet) instead of inlined page content; fetch a result's full page content on demand with FetchURL. Both tools now include a citation reminder in their results.
