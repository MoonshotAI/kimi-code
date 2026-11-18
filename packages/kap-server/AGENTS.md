# kap-server Agent Guide

`@moonshot-ai/kap-server` exposes the Kimi Agent Protocol (KAP `1.0.0`) over `/api/v1` REST and `/api/v1/ws` WebSocket. Its primary external consumers are live AI agents supervising Kimi Code over plain HTTP (`:wait`, `/interactions`, `/turns`, `/prompts`, `/steer`) and lightweight bots or custom UIs, alongside first-party Desktop and Web clients.

## Guidelines

### 1. Core Loop Compatibility (Do Not Freeze Host Management Routes)

- **Core session & conversation loop stays compatible**: Keep default parameter semantics and response shapes backward-compatible on the core external KAP surface: `/api/v1/meta`, `/api/v1/kap.md`, `/api/v1/sessions` (plus `:wait`, `:cancel`, `:fork`, `:undo`, `:archive`, `:restore`, `/profile`), `/agents/{agent_id}/turns`, `/prompts`, `/steer`, `/interactions`, `/files`, and core WebSocket conversation/state frames (`subscribe`, `turns`, `turn.*`, `item.*`, `interaction`, `agent`, `task.*`). Gate new opt-in behaviors behind optional parameters or new `:action` suffixes, and advertise new external capabilities on `GET /api/v1/meta` → `data.capabilities` when agents/clients need runtime feature detection.
- **First-party host management routes stay free to evolve**: Host administration endpoints (`/config`, `/providers`, `/models`, `/oauth/*`, `/mcp/*`, `/plugins/*`, `/capabilities/*`, `/devices*`, `/remote-control*`, `/workspaces*`, `/fs:*`) serve first-party Desktop/Web UIs and may change freely with the product — sync `code-app` and `apiSurface.snapshot.test.ts` when updating them, without adding compatibility shims for external callers.

### 2. Wire Conventions & Built-In Spec Sync

- **Public wire fields use `snake_case`**: Request bodies, query strings, response `data` payloads, and WebSocket frames use `snake_case` field names (explicitly documented passthrough payloads excepted).
- **Keep `docs/kap.md` in sync with core loop changes**: `GET /api/v1/kap.md` serves `packages/kap-server/docs/kap.md` directly from the running binary. Whenever you change connection bootstrap (`kimi web --json`, `server.token` / `instances`), core session/conversation/interaction endpoints, or `meta.capabilities`, update `packages/kap-server/docs/kap.md` (and `skills/use-kimi-code/SKILL.md` / `docs/{en,zh}/guides/other-agents.md` if connection bootstrap changes). Keep `docs/kap.md` concise (~500 lines) and delegate field-level schemas to live `/openapi.json` and `/asyncapi.json`.
