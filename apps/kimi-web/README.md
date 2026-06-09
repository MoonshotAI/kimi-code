# Kimi Web

A browser client for Kimi Code — a peer to the TUI (`apps/kimi-code`) that talks
to a local **daemon** over REST + WebSocket. Vue 3 + Vite + TypeScript.

---

## Quick start

```bash
# 1) Against a REAL daemon (the daemon must be running and reachable)
WEB_PORT=5197 KIMI_DAEMON_URL=http://192.168.97.91:7878 pnpm -C apps/kimi-web run dev
#   …or from the repo root:  pnpm dev:web   (uses the defaults below)

# 2) Offline / no daemon — a stub that fakes the daemon API + event stream
pnpm -C apps/kimi-web run dev:stub      # then run dev in another shell

# checks
pnpm -C apps/kimi-web run typecheck     # vue-tsc --noEmit
pnpm -C apps/kimi-web run test          # vitest
pnpm -C apps/kimi-web run build         # vite build
```

### How it connects to the daemon

The browser cannot reach the daemon cross-origin (no CORS), so Vite **same-origin
proxies** `/api/v1` (HTTP + WS) to the daemon (`vite.config.ts`):

| env var           | default                  | meaning                                  |
| ----------------- | ------------------------ | ---------------------------------------- |
| `WEB_PORT`        | `5175`                   | port the dev server listens on           |
| `KIMI_DAEMON_URL` | `http://127.0.0.1:7878`  | where `/api/v1` (and `/api/v1/ws`) is forwarded |

> Behind a corporate HTTP proxy, also set `NO_PROXY=<daemon-host>` (e.g.
> `NO_PROXY=192.168.97.91`) so the proxy forward reaches the daemon directly.

---

## Architecture

A strict one-direction data flow; components never touch the network or the
reducer — they consume computed view props and call actions.

```
daemon (REST + WS)
  └─ src/api/daemon/client.ts      REST adapter  (envelope → AppX types)
  └─ src/api/daemon/ws.ts          WS frames → classify → projector/reducer
       └─ agentEventProjector.ts   RAW agent-core events → AppEvent[]
       └─ eventReducer.ts          AppEvent[] → state
  └─ src/composables/useKimiWebClient.ts   the ONLY place that imports api + state;
                                           exposes computed view props + actions
  └─ src/components/*.vue          render props, emit intents (no api access)
```

- **Adapter** (`src/api/`): wire types are snake_case; `AppX` types are camelCase.
  `config.ts` builds `/api/v1` URLs.
- **Event projector** (`agentEventProjector.ts`): the daemon streams **raw
  agent-core events** (no `event.` prefix). `classifyFrame` routes raw vs
  protocol (`event.*`) frames; the projector converts them to `AppEvent`s.
- **i18n** (`src/i18n/`): vue-i18n, en/zh, per-namespace flat camelCase keys.
  Detect order: `localStorage('kimi-locale')` → `navigator.language` → `en`.
- **Tests**: Vitest + @vue/test-utils + jsdom, colocated under `__tests__/`.

---

## Daemon contract — non-obvious notes

The daemon's wire protocol has a few things that will bite you if forgotten:

- **Envelope:** every response is `{ code, msg, data, request_id }` and the HTTP
  status is **always 200** — check `code` (0 = ok), not the status.
- **Prompts require five fields.** `POST /sessions/{id}/prompts` must carry
  `{ content, model, thinking, permission_mode, plan_mode }`. The web fills these
  from settings (model ← session/`default_model`, thinking/permission/plan ← the
  StatusLine controls). Sending only `{ content }` → `40001 model …`.
- **Creating a session needs a *registered* workspace.** `workspace_id` must be a
  `wd_<slug>_<hash>` id that exists in the daemon's registry. Sessions get one
  auto-assigned by cwd, but it isn't *registered* until you `POST /workspaces
  { root }` (idempotent). The web registers on demand before `createSession`
  (otherwise: `workspace not found: wd_…`).
- **Persisted sessions are directly promptable** — selecting an old session and
  sending a message just works; there is **no `:activate` step**.
- **Workspaces** = real folders. `GET/POST/PATCH/DELETE /workspaces`,
  `GET /fs:browse?path=`, `GET /fs:home` back the rail + folder picker.

---

## What's still missing / blocked on the daemon

See **`docs/main-flow-gaps.md`** (the main-flow gap audit) and
**`docs/backend-workspace-session-asks.md`** (the endpoint asks for the backend).

Daemon endpoints that are **not live yet** (probed; the web degrades gracefully):

- `/sessions/{id}:compact`, `:fork`, `:steer`, `/undo` → `400` (no such action)
- line-by-line `diff` → `404`
- `GET /sessions/{id}/status` → `404` (the `/status` panel is rendered from
  client state instead)
- `/goal`, `/btw`, `/mcp`, `/init`, `/reload`, `/settings`, `/plugins` → absent

Everything client-side (workspace rail, sessions, chat/stream, approvals,
tools/diff/files, model/provider/login, thinking/plan/permission controls,
`/status`, queue edit, syntax highlighting, i18n) is implemented.

---

## Design docs

Living under `docs/` (design rationale + plans):

- `docs/workspace-session-design.html` — workspace ⇄ session model + flows
- `docs/dual-sidebar-exploration.html` — sidebar layout options (Variant B shipped)
- `docs/kimi-web-final-form.html` — target-state UI mockup
- `docs/main-flow-gaps.md` — feature gap audit (what to build next)
- `docs/backend-workspace-session-asks.md` — endpoints the daemon still needs
