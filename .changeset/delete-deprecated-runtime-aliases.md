---
"@moonshot-ai/kimi-code": minor
---

Remove deprecated DI aliases left over from the runtime-services refactor. The `IAgentEventBus` / `AgentEventBus` re-export is gone (use `IDomainEventBus` / `DomainEventBus`); the `ICoreProcessService` alias is gone (use `ICoreRuntime`); and the deprecated `ISessionService.list` / `listChildren` / `getStatus` thin wrappers are gone (use `ISessionQueryService.list` / `listChildren` and `ISessionRuntimeService.getStatus`). The `'coreProcessService'` decorator string is unchanged for now.
