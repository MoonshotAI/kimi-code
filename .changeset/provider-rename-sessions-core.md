---
"@moonshot-ai/agent-core-v2": patch
---

Save retired model redirects to the document store so they survive restarts, saving them in the order they are recorded, and let provider discovery record several redirects at once and report when saved redirects have loaded. A redirect is dropped once its old alias is configured again. Agent loops follow a redirect when it is recorded or when the models section changes, resumed agents apply it after a restart, and the missing-model check no longer reports an alias whose redirect points at a model that resolves. A model whose provider is not configured now counts as a missing configured model, and its error carries the model and provider names.
