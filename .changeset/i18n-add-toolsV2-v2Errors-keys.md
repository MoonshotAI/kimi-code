---
"@moonshot-ai/agent-core": patch
---

Add two missing i18n namespaces to the `agent-core` locale files:

- `toolsV2.abort.abortedByUser` — `"Interrupted by user"` / `"被用户中断"`, matching the existing `shell.userInterrupt` text. Consumed by `agent-core/src/agent/background/index.ts`.
- `v2Errors.mainAgentNotFound` — `"Main agent was not found"` / `"未找到主 Agent"`, matching the existing `errors.agentNotFound` text. Consumed by `agent-core/src/session/index.ts`.

Without these keys the `t()` fallback in `packages/i18n-shared/src/core.ts` returned the raw key string (e.g. `"toolsV2.abort.abortedByUser"`) to users; both `en.ts` and `zh.ts` are updated and the corresponding `.json` artifacts regenerated via `pnpm generate:locale-json`.