# server Agent Guide

Package-local rules for `packages/server` (`@moonshot-ai/server`).

## What it is

The Kimi Code server. It hosts `agent-core` sessions and exposes them over REST + WebSocket under a single `/api/v1` prefix. It is consumed by `apps/kimi-code` (the CLI/TUI) — **do not add a reverse dependency** on the CLI app.

## Entry points & launch

- Bootstrap: `src/start.ts` exports `startServer(opts): Promise<RunningServer>`. The public surface is re-exported from `src/index.ts`.
- Dev: run from the **repo root** with `pnpm dev:server` (auto-restart variant `pnpm dev:server:restart`). This shells into `kimi server run` via `apps/kimi-code`. This package has **no `dev` script** of its own.
- Prod: the CLI command `kimi server run` (`apps/kimi-code/src/cli/sub/server/run.ts`) imports `startServer`.

## Layout (`src/`)

- Top level: `start.ts`, `index.ts`, `envelope.ts`, `error-handler.ts`, `lock.ts`, `request-id.ts`, `version.ts`.
- `routes/` — REST domain modules, the `registerApiV1Routes.ts` aggregator, `webAssets.ts`, and `action-suffix.ts`.
- `services/` — server-owned DI adapters: `approval/`, `question/`, `gateway/` (`rest`/`ws`/`broadcast`/`connectionRegistry`/`sessionClients`/`sessionEventJournal`/`inFlightTurnTracker`), `pinoLoggerService.ts`, `serviceCollection.ts`.
- `ws/` — `connection.ts` (`WsConnection`), `protocol.ts` (frame builders), `rawData.ts`.
- `middleware/` — `defineRoute.ts`, `schema.ts`, `validate.ts`. `openapi/transforms.ts`.
- `svc/` — OS service managers (launchd / systemd / schtasks) backing `kimi server install/start`.

## DI: how it consumes `@moonshot-ai/agent-core`

Service conventions (naming, file layout, registration) live in `packages/agent-core/src/services/AGENTS.md` — read that before adding or changing a service. This package only wires the container:

- `src/services/serviceCollection.ts` `createServerServiceCollection(...)` seeds a `ServiceCollection` with `...getSingletonServiceDescriptors()` plus server-owned gateway singletons (`ConnectionRegistry`, `SessionClientsService`, `WSBroadcastService`) and overrides `IApprovalService` / `IQuestionService`.
- `services.set(...)` overrides: `ILogService` (Pino adapter), `IRestGateway` (`FastifyRestGateway(app)`), `IEnvironmentService`; then `IWSGateway` / `ICoreProcessService` as `SyncDescriptor`s with options; then `server.serviceOverrides` last (the test seam — later registration wins).
- `start.ts` builds `new InstantiationService(services)`, eagerly resolves services inside `ix.invokeFunction(...)`, wires `wsGw.setAbortHandler/setTerminalHandler/setFsWatchHandler`, manually creates + registers `FsWatcherService`, awaits `coreProcess.ready()`, then binds via `listenWithPortRetry(...)` (wraps `IRestGateway.listen`).

## Wire layer

- REST is **Fastify**. All v1 routes are registered under `/api/v1` in `routes/registerApiV1Routes.ts`. Declare routes with `middleware/defineRoute.ts`: one object carries the Zod validators and the OpenAPI response schema; the `200` schema is expanded into the envelope `oneOf`.
- `start.ts` neuters Fastify's validator/serializer compilers — validation happens in `defineRoute` preHandlers, not in Fastify's own pipeline.
- Doc/meta endpoints in `start.ts`: `/openapi.json` (`@fastify/swagger`, lazily imported), `/asyncapi.json` (`createAsyncApiDocument` from `@moonshot-ai/protocol`), `/healthz`. `webAssetsDir` enables `registerWebAssetRoutes`.
- WebSocket uses the `ws` package; frames/envelopes live in `ws/protocol.ts` (`server_hello`, `ack`, `event`, `resync_required`, per-session `seq`).

## Commands

- `pnpm --filter @moonshot-ai/server build` — `tsdown`.
- `pnpm --filter @moonshot-ai/server typecheck` — `tsc -p tsconfig.json --noEmit`.
- `pnpm --filter @moonshot-ai/server test` — `vitest run`.
- `pnpm --filter @moonshot-ai/server clean` — `rm -rf dist`.
- Dev server: `pnpm dev:server` at the repo root.
- E2E: in-process tests live in `test/*.e2e.test.ts` and boot `startServer` directly. Live e2e against a running server lives in `packages/server-e2e` (default `http://127.0.0.1:58627`, override with `KIMI_SERVER_URL`).

## Gotchas / hard rules

- **Path alias:** `#/*` maps to `./src/*.ts` (with `#/services/...` variants). Use `#/...`, not `@/`.
- **Single-instance lock:** `start.ts` calls `acquireLock`; a second start throws `ServerLockedError`. Tests must pass a unique `lockPath`/`port` and use `serviceOverrides`.
- **Port-busy policy:** the lock is acquired *before* binding, so any `EADDRINUSE` from `listen` is a third-party listener (never another kimi server). `listenWithPortRetry` then walks `port + 1`, `+ 2`, … (capped by `PORT_RETRY_LIMIT`) and calls `lockHandle.updatePort(boundPort)` so the lock advertises the real port. Port `0` (ephemeral) is never retried. The daemon spawner mirrors this in `resolveDaemonPort` (`apps/kimi-code`).
- **Uniform response envelope** `{ code, msg, data, request_id }` (`envelope.ts`, `error-handler.ts`); request id comes from `request-id.ts` / `genReqId`.
- **`:action` URL convention** is handled by `routes/action-suffix.ts` (`parseActionSuffix`) — Fastify cannot disambiguate `:id` from `:id:action` on its own.
- **`FsWatcherService` is created manually and `services.set`-registered after the collection is built** — this is ordering-sensitive; keep the boot wiring in `start.ts`.
- `debugEndpoints` is opt-in: only register `registerDebugRoutes` when `opts.debugEndpoints === true`. Swagger plugins are dynamically imported.
