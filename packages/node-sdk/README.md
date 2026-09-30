# @moonshot-ai/kimi-code-sdk

The TypeScript SDK for Kimi Code.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

This package is a composition layer over `@moonshot-ai/agent-core` (v3) and
`@moonshot-ai/harness-core`: `createKimiHarness` mounts the Kimi feature set
(profiles, skills, MCP, permission, compaction, session export, models.dev,
plugins, ...) onto a filesystem-backed session space and returns a single
harness object. It is v3-backed end to end — there is no v2 compatibility
surface: the old `Session` / `Event` / config-RPC API was removed, and every
capability is reached through the facades below.

## Quickstart

```ts
import { createUserMessage } from '@moonshot-ai/agent-core';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

const harness = await createKimiHarness({ workDir: process.cwd() });
try {
  await harness.ensureConfigFile();
  const session = await harness.createSession();
  const result = await session.main.run(createUserMessage('Say hello.'));
  console.log(result.outcome);
} finally {
  await harness.close();
}
```

`createKimiHarness` options: `workDir` (required), `homeDir`, `configPath`,
`identity`, `version`, `userAgent`, `uiMode` (`'interactive' | 'print'` —
print mode makes permission non-interactive), `skillDirs`, `additionalDirs`,
`telemetry`, `onOAuthRefresh`.

## Harness surface

- `harness.config` — typed config facade over `config.toml`:
  `get(name)`, `set(name, value, target?)`, `replace(sections, target?)`,
  `reload()`, `diagnostics()`.
- `harness.auth` — OAuth/managed-auth facade: `login`, `logout`, `status`,
  `getCachedAccessToken`, `getManagedUsage`, feedback upload helpers.
- `harness.trust` — workspace trust store (`isTrusted(workDir)`, ...).
- `harness.app` — the underlying agent-core `AppHandle`; resolve feature
  facades (`PermissionRef`, `GoalRef`, `ModelsDevRef`, `McpRef`, ...) and
  manage sessions directly when the convenience methods are not enough.
- `harness.homeDir` / `workDir` / `configPath`.
- `harness.track(event, properties)` / `harness.setTelemetryContext(patch)` —
  telemetry hooks (a no-op client unless one is injected).
- `harness.ensureConfigFile()`, `harness.close()`.

## Sessions

- `harness.createSession(input?)` / `harness.resumeSession(id)` /
  `harness.forkSession(fromId)` → `KimiSession`.
- `harness.listSessions()` / `harness.deleteSession(id)` /
  `harness.renameSession(id, title)` / `harness.exportSession(id, opts)`.
- `session.id`, `session.handle` (the v3 `SessionHandle` — agent registry and
  session-tier events), `session.main` (the main `AgentHandle`: `run`, `on`,
  `wait`, `resolve`, `setConfig`, `setRequester`), `session.close()`.

Agent and session event types (`AgentEmitted`, turn/tool/llm events), message
helpers (`createUserMessage`), and feature facade tokens come from
`@moonshot-ai/agent-core` / `@moonshot-ai/harness-core` directly; this package
does not re-wrap them.

## License

MIT
