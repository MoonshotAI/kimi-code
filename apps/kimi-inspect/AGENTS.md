# kimi-inspect Agent Guide

Web inspector for the kap-server `/api/v1/debug` RPC surface — workspace/session browser, per-session chat, and Service panels (data + trigger buttons) for the Session and Agent scopes.

## Top-level views

A left icon rail (`src/components/NavRail.tsx`) switches top-level views:

- **Chat workspace** — the per-session chat (see "Chat view" below), with the session table on the left: `src/components/Sidebar.tsx` is a spreadsheet-like table panel over `GET /api/v2/sessions` (client in `src/sessions/api.ts` — v1-style `{ code, msg, data }` envelope, opaque-cursor pagination; preset views in `src/sessions/views.ts` map onto the endpoint's status / archived / git query conditions), with column visibility + active view persisted to localStorage, server-side sort toggles on the Updated / Created headers, live activity badges from the hub, and a per-workspace grouped view.
- **Global message search** (`src/components/SearchView.tsx`) — cross-session full-text search over `POST /api/v1/search`, cursor-paged via a manual Load more; an exact-match checkbox maps to the API's `mode: 'literal'` substring search, which ignores sort and orders newest-first; a `live`/`index` badge on the results shows which server route served them (in-memory session transcript vs the persisted index).
- **Model Catalog** (`src/components/ModelCatalogView.tsx`) — every Provider with its Models and the default marker, via `IModelCatalog` / `IModelService` channel proxies. Expanding a Model opens the model inspector inside that view: provider/model config layers plus the resolved runtime view with per-value provenance (config / override / builtin / env / synthesized), served on demand by `IModelCatalog.inspect` — the same resolution pass the runtime's `get` serves, traced via `ResolutionTraceCollector` and assembled by `kosong/model/inspection.ts`.
- **App Services** (`src/components/AppServicesView.tsx`) — the app-scope Service reflection, full width, joined by the **Workspace Services** view (`src/components/WorkspaceServicesView.tsx`) — the workspace-scope counterpart with a left sidebar directory browser (`src/components/WorkspaceDirBrowser.tsx` — server-side fs browsing over the App-scope `IHostFolderBrowser`, marking entries that are registered workspaces with their `IWorkspaceTrust` trust state, and registering a picked folder on demand via `IWorkspaceService.createOrTouch`), its proxies riding the `/workspace/:id` route, which materializes the handler on demand via `IWorkspaceLifecycleService.handlerFor`.
- **DI view** (`src/components/DiInspectionView.tsx`) — the engine's Service × Effect × DI debug surface over the App-scope `IDebugLedgerService` / `IDebugGraphService` / `IDebugEventsService` / `IDebugCascadeService`: the unit tree = ledger tree with unprovide / update / dispose triggers, the dependency DAG as Miller columns (`di/DiGraphPanel.tsx`), the event-subscription ledger (unit-book `on:<name>` entries + per-bus listener counts, `di/DiEventsPanel.tsx`), the cascade history, and the waiting area; the five panels poll on a short interval and refresh eagerly off the global `event.di.unit_changed` WS frame via `src/activity/di.ts`, which invalidates the `['di']` react-query prefix.

The **Agent scope** stays in the Chat view's right dock (`src/components/RightPanel.tsx`) across two tabs:

- `Agent` tab — `Inspector`: agent switcher + a Plan lookup card (`PlanCard` in `src/components/Inspector.tsx` — querying `GET /sessions/{id}/transcript/plan` (one tool_call_id, or every plan of the agent) via `src/transcript/api.ts`'s `fetchTranscriptPlan`) plus the agent Service panels.
- `State` tab — every key an Agent Service registered into the agent-state container, polled live via `IAgentStateService.snapshot()` — the same live diff-tree view as the session State tab, sharing `StateCard` from `src/components/StateCard.tsx`.

The **Session scope** has its own column right next to the session-list sidebar (`src/components/SessionPane.tsx`) with two tabs: Services (the pending-interactions card — `src/components/InteractionsCard.tsx` — plus the session Service panels) and State (every key a Session Service registered into the session-state container, read on demand via `ISessionStateService.snapshot()`).

## Channel layer

Built on its own old-klient-style channel layer (`src/channel/`: the VS Code `ProxyChannel` model — service-bound `IChannel`, HTTP `ProxyChannel` for calls routed to `/api/v1/debug`), typed by `agent-core-v2` Service interfaces; `GET /api/v1/debug/channels` loads the whole wire protocol 1:1 (every scoped Service, no whitelist). There is no Service-event push channel: panels fetch/refresh on demand (`Sidebar` polls react-query on a 15 s interval), and a connection failure shows a blocking "Debug surface unavailable" screen instead of falling back anywhere.

## Session activity

Session-level coarse status is the one exception to no-push: `src/activity/` holds a second `/api/v1/ws` client (`GlobalEventsWs`) that subscribes to nothing and consumes the server-pushed global facts — `event.session.work_changed` updates a per-session activity map (`SessionActivityHub` + subscribe/version store, seeded on connect/reconnect from `GET /api/v1/sessions`), while `event.session.created` / `session.meta.updated` invalidate the `['sessions']` / `['v2-sessions']` queries; the session table rows render `running` / `approval` / `question` / `failed` badges from it via `useSessionActivities` (live facts override the REST `activity.status`).

## Dev server

The Vite dev server proxies `/api` to a running kap-server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`) and exposes `GET /__inspect/servers` (`vite/serverDiscovery.ts`), which scans the local kap-server instance registry (`~/.kimi-code/server/instances` + legacy `lock`) and the home token so the app can zero-config auto-connect and switch servers from the header dropdown at runtime.

## Chat view

The per-session chat (`src/components/ChatView.tsx`) renders turn-granularly from the **transcript** surface instead of context memory and carries an in-chat search bar (`src/components/ChatSearchBar.tsx`): it searches the current session via `POST /api/v1/search` with `container: { session_id }` (usually served by the live route, since selecting a session resumes it), and a result click funnels through the app shell's `openSearchHit` — the same agent-switch + `ChatJump` (page-back, scroll, flash) path the global search view uses.

Full state is read from `GET /api/v1/sessions/{id}/transcript` (initial load = newest page, refreshes re-read from the tail backwards), older history auto-pages with `before_turn` via an IntersectionObserver sentinel at the top of the scroll view, and each timeline item is wrapped in `content-visibility: auto` + `contain-intrinsic-size` so the browser virtualizes off-screen rendering natively (no windowing library).

`/api/v1/ws` is an incremental channel (`transcript.ops`, grade `block` — the cheapest grade that still carries whole-state frame upserts, dropping per-token `append` frames; `transcript.reset` is ignored by the store, surfaced only to the audit recorder via the optional `onReset` handler). The channel tracks the op-batch watermark: a dedicated `subscribe_v2` control frame carries the per-agent grades and the `transcript_since` cursor, a seq gap / reconnect / `resync_required` / append gap triggers a point-to-point catch-up (`fetchTranscriptOps` → `GET .../transcript/ops?since_seq=`), and any legacy/incomplete answer falls back to the full REST refresh. Convergence reuses `@moonshot-ai/transcript`'s L2 reducer (`src/transcript/`: REST/WS clients + store; the data model and reducer come from the package, nothing is re-implemented locally).

## Transcript audit panel

The Transcript audit panel (`src/components/audit/`, the `Audit` tab of the chat view's right dock — `src/components/RightPanel.tsx`, fed the trail by `ChatView`'s `onTrailChange`) replays how the visible store was built: an `AuditTrail` (`src/audit/`) records every step — each REST page (request + replace/prepend), every WS frame (`transcript.ops` live/buffered/flushed/catchup, `transcript.reset`), loss signals, and prompt/cancel actions — with the resulting immutable `AgentState` per entry; the panel offers a draggable timeline plus a Diff tab (structural diff vs the previous entry: added/modified/removed colored, long strings tail-truncated, all fields kept), a full State view, and the raw Event payload.
