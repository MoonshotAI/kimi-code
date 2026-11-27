---
"@moonshot-ai/agent-core-v2": patch
---

Save retired model redirects to the document store so they survive restarts, and let provider discovery record several redirects at once and report when saved redirects have loaded. Agent loops follow a redirect when it is recorded or when the models section changes, resumed agents apply it after a restart, and the missing-model check no longer reports an alias that has a redirect. A model whose provider is not configured now counts as a missing configured model, and its error carries the model and provider names.
