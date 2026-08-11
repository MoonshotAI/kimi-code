# Kimi Web

Browser client for Kimi Code — a peer to the TUI that talks to a local
**server** over REST + WebSocket. Vue 3 + Vite + TypeScript.

Since phase 3 this app is **no longer a monolith**: it aggregates the three
source-only shared packages (`exports → ./src/*`, transpiled by this app's
bundler) and keeps only the web-specific glue:

- `@moonshot-ai/app-ui` — presentational components + design tokens.
- `@moonshot-ai/app-markdown` — chat Markdown renderer.
- `@moonshot-ai/app-core` — daemon transport, session state machine, state
  container, appearance composables.

---

## Quick start

```bash
# from the repo root
pnpm dev:web                 # vite dev server (proxies /api/v1 to KIMI_SERVER_URL)
pnpm -C apps/web run dev:stub  # offline stub faking the server API + event stream

# checks
pnpm -C apps/web run typecheck   # vue-tsc --noEmit
pnpm -C apps/web run test        # vitest (pure logic only)
pnpm -C apps/web run build       # vite build → apps/web/dist
```

### How it connects to the server

The browser cannot reach the server cross-origin (no CORS), so Vite **same-origin
proxies** `/api/v1` (HTTP + WS) to the server (`vite.config.ts`):

| env var           | default                  | meaning                                              |
| ----------------- | ------------------------ | ---------------------------------------------------- |
| `WEB_PORT`        | `5175`                   | port the dev server listens on                       |
| `KIMI_SERVER_URL` | `http://127.0.0.1:58627` | where `/api/v1` (and `/api/v1/ws`) is forwarded      |

> Behind a corporate HTTP proxy, also set `NO_PROXY=<server-host>` (for example,
> `NO_PROXY=127.0.0.1,localhost`) so the proxy forward reaches the server directly.

`vite.config.ts` also carries the two consumer requirements the shared packages
need: the unplugin-icons `kimi` collection (`~icons/kimi/*`) and
`worker: { format: 'es' }` for app-markdown's off-thread KaTeX / Mermaid workers.

---

## Architecture

`src/api/bootstrap.ts` is the only module that knows both sides: it composes
app-core's `DaemonKimiWebApi` with this app's bridges — `tracer` (`debug/trace`),
`credentialStore` (`lib/serverAuth`), and the required `projectorFactory`
(`src/api/daemon/agentEventProjector.ts`) — and exposes the shared `api`
singleton (plus a `getKimiWebApi()` back-compat accessor).

`src/main.ts` stays thin: `createApp(App).use(i18n)`, an
`app.provide(IconResolverKey, …)` that bridges app-ui's `<Icon>` to this app's
icon registry (`lib/icons.ts`), and a desktop-only theme-IPC bridge that mirrors
`<html data-color-scheme>` to the host's `nativeTheme`. There is **no** client
factory / `provide` of an un-singletoned client here — that is deferred to a
later phase.

`src/api` keeps only the web-specific glue (`bootstrap`, `config`,
`daemon/agentEventProjector`, `errors`, `index`, `types`); the transport,
reducer, and state container live in `@moonshot-ai/app-core`. `i18n` and tool
metadata stay in this app.

```
server (REST + WS)
  └─ @moonshot-ai/app-core/api   DaemonKimiWebApi (transport + projector + reducer)
        └─ src/api/bootstrap.ts  injects tracer / credentialStore / projectorFactory → api
  └─ @moonshot-ai/app-core       createKimiWebClientCore({ api, t }) → reactive state
  └─ @moonshot-ai/app-ui         <Button> / <Dialog> / <Icon> / tokens
  └─ @moonshot-ai/app-markdown   <Markdown>
  └─ src/components/*.vue        render props, emit intents (no transport access)
```

---

## Server contract — non-obvious notes

The server's wire protocol has a few things that will bite you if forgotten:

- **Envelope:** every response is `{ code, msg, data, request_id }` and the HTTP
  status is **always 200** — check `code` (0 = ok), not the status.
- **Persisted sessions are directly promptable** — selecting an old session and
  sending a message just works; there is no `:activate` step.
- **Creating a session needs a *registered* workspace.** `workspace_id` must be a
  `wd_<slug>_<hash>` id that exists in the server's registry.

## Release & deployment

`build → dist` produces `apps/web/dist`. It is consumed two ways, never
published as a standalone package:

1. **Desktop** — `apps/desktop/scripts/copy-web-dist.mjs` copies `apps/web/dist`
   into `apps/desktop/web-dist/` at desktop build time.
2. **SEA / CLI embed** — `pnpm run sync:web` builds the web and syncs `dist` into
   the kimi-code submodule's `apps/kimi-code/dist-web/` for SEA embedding.
