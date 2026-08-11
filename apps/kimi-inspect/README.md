# kimi-inspect

Web inspector for the kap-server `/api/v1/debug` RPC surface — a read/trigger
window into a running Kimi Code engine (workspaces, sessions, agents, and the
scoped DI registry).

## Run

1. Start a kap-server with the debug surface mounted (repo dev scripts do this
   for you): `pnpm dev:v1` / `pnpm dev:v2` from the repo root pass
   `--debug-endpoints` on a loopback bind; the surface inherits the global
   bearer auth.
2. `pnpm --filter @moonshot-ai/kimi-inspect dev` — the Vite dev server proxies
   `/api` to the server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`)
   and auto-discovers running instances
   (`~/.kimi-code/server/instances`); switch servers from the header dropdown.

A connection failure shows a blocking "Debug surface unavailable" screen —
there is no fallback data source.

## Views (left icon rail)

- **Chat workspace** — session list (activity badges from the global-events WS)
  plus a transcript-driven per-session chat; the right dock hosts the
  Agent-scope Service panels, a plan lookup card, and the transcript audit
  panel. The Session scope has its own column (pending interactions + session
  Service panels, and a State tab).
- **Search** — cross-session full-text search over `POST /api/v1/search`
  (cursor-paged; exact-match maps to the API's `literal` mode; a `live`/`index`
  badge shows which server route served the results).
- **Model Catalog** — every provider with its models; expanding one opens the
  model inspector (config layers + resolved runtime view with per-value
  provenance).
- **App / Workspace Services** — the full Service reflection over the App
  scope, and over each Workspace scope (picked via the directory browser;
  workspace handlers materialize on demand).
- **DI** — the engine's Service × Effect × DI debug surface, four panels fed
  by the App-scope debug Services (`IDebugLedgerService` / `IDebugGraphService`
  / `IDebugCascadeService`) and refreshed eagerly off the `event.di.unit_changed`
  WS frame:
  - **Unit tree** — scope → unit → ledger entries (label, five-state
    `Pending / Activating / Active / Unloading / Failed`, uid, `pinned` flag,
    unit error object), with **unprovide / update / dispose** triggers.
  - **Graph** — the dependency DAG (instance edges across scopes + collection
    edges).
  - **Cascade** — the cascade transaction history ring (changes, contagion set,
    torn-down / rebuilt / failed, abort wait, duration).
  - **Pending** — the waiting area: units parked on unsatisfied dependencies
    with their missing-token sets.

## Notes for maintainers

- The channel layer (`src/channel/`) is a VS Code-style `ProxyChannel`:
  `GET /api/v1/debug/channels` enumerates every scoped Service — there is no
  whitelist; new Services appear automatically.
- There is no Service-event push channel besides the global events listed
  above; panels fetch/refresh on demand (react-query, 15 s poll) plus the
  `event.di.unit_changed` invalidation for the DI view.
