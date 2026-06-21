---
"@moonshot-ai/kimi-code": minor
---

Introduce the `ICoreRuntime` runtime facade (in-process core access via `ready()`, `dispose()`, and `getCoreApi()`) and deprecate `ICoreProcessService` as a back-compat alias. Existing consumers keep working unchanged; core teardown now short-circuits RPC dispatch after dispose.
