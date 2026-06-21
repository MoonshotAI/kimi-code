---
"@moonshot-ai/kimi-code": minor
---

Refactor the in-process DI service layer into a domain-runtime-services architecture. Each aggregate decomposes into command / query / runtime / repository / index roles with explicit owners (e.g. `session/` → `ISessionService` + `ISessionQueryService` + `ISessionRuntimeService`, with `SessionRepository` / `SessionIndex` owned by the runtime layer). Facades no longer depend on the `CoreRPC` mega-proxy: they route to the in-process core through `ICoreRuntime.getCoreApi()` or through peer domain services. Cross-cutting effects move onto domain lifecycle hooks (`onSessionWillStart`, `onSessionWillClose`, `onAgentWillResume`, …) over the `IDomainEventBus`, with core-to-protocol event projection at the boundary. `ICoreRuntime` replaces `ICoreProcessService` and the deprecated aliases are gone, and a dependency-direction fence enforces runtime ↛ services, repository/index ↛ services, and no cross-service business imports.
