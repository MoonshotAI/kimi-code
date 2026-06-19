# kimi-web Agent Guide

Package-local rules for `apps/kimi-web` (`@moonshot-ai/kimi-web`).

## What it is

The browser web UI for Kimi Code — a peer to the TUI in `apps/kimi-code`. It talks to the local server over REST + WebSocket under `/api/v1`. Stack: Vue 3 + Vite 6 + TypeScript (strict) + Tailwind v4 + vue-i18n v11. There is no client router and no Pinia; state lives in composables/refs and provide/inject.

## Layout (`src/`)

- `main.ts` — bootstrap (creates the app, installs i18n, mounts `#app`). `App.vue` — root component, holds most app state.
- `api/` — server client. `index.ts` exposes the `getKimiWebApi()` singleton; `config.ts` builds REST/WS URLs; `daemon/` holds the wire client (`http.ts`, `ws.ts`, `wire.ts`, `mappers.ts`, `agentEventProjector.ts`, `eventReducer.ts`).
- `components/` — ~50 flat SFCs, no subdirectories.
- `composables/` — reusable state logic, `useX` naming (`useKimiWebClient`, `useIsDark`, `usePaneLayout`, …).
- `lib/` — pure helpers (`parseDiff`, `slashCommands`, `sessionRoute`, `toolMeta`, …).
- `i18n/` — vue-i18n setup plus locale namespaces.
- `debug/` — `DebugPanel.vue` and `trace.ts` for client error/trace capture.

## Vue conventions (normative)

- SFCs use **`<script setup lang="ts">`** + the Composition API. Component files are **PascalCase** (`ChatHeader.vue`).
- Type props with the generic form `defineProps<{ ... }>()`; type emits with `defineEmits<{ evt: [arg: Type] }>()`.
- Shared components go in `src/components/`; reusable logic goes in `src/composables/` with a `use` prefix.
- There is **no auto-import plugin** and **no path alias** — `#/` and `@/` are intentionally unused. Write relative imports (`../i18n`, `./config`).

## i18n (normative — keeping locales in sync is manual)

- Setup: `src/i18n/index.ts`, vue-i18n in Composition mode (`legacy: false`), fallback `en`. The active locale is persisted in `localStorage` under `kimi-locale`.
- Locale files: `src/i18n/locales/{en,zh}/<namespace>.ts`, each `export default { ... } as const`. New namespaces are registered in `src/i18n/locales/index.ts`.
- Reference with `const { t } = useI18n()` and `t('namespace.key')` (same form in templates).
- **Adding a key:** add it to **both** `en/<ns>.ts` and `zh/<ns>.ts`. **Adding a namespace:** create the file in both locales **and** register it in `locales/index.ts`.
- There is **no automated missing-key or en/zh parity check**. Keeping the two locales in sync is a manual responsibility — do not leave a key present in only one locale.

## Commands

All via `pnpm --filter @moonshot-ai/kimi-web …`:

- `dev` — Vite dev server (port `WEB_PORT`, default 5175; proxies `/api/v1` to `KIMI_SERVER_URL`, default `http://127.0.0.1:58627`).
- `dev:stub` — offline stub daemon (`dev/stub-daemon.mjs`).
- `build` — production build into `dist/`.
- `typecheck` — `vue-tsc --noEmit`.
- `test` — `vitest run` (jsdom; setup in `test/setup.ts`).
- There is **no `lint` script** in this package; linting runs at the repo root via oxlint.

## Gotchas / hard rules

- **Do not depend on `@moonshot-ai/agent-core`** (mirrors the CLI/SDK rule). The web app is decoupled from core/protocol; wire types are re-implemented locally in `src/api/daemon/wire.ts`. Keep it that way.
- **Same-origin by default:** the browser only talks to its own origin; Vite proxies `/api/v1` for both HTTP and WS. Set `VITE_KIMI_SERVER_HTTP_URL` only when you intentionally want direct (CORS) mode.
- Vite-injected globals (`__KIMI_DEV_PROXY_TARGET__`, `__KIMI_WEB_VERSION__`, `__KIMI_WEB_COMMIT__`) are declared in `src/env.d.ts` and defined in `vite.config.ts`. Do not hand-edit `dist/`.
- **Theming:** the root element carries `data-color-scheme` (`light` | `dark` | `system`); react to it through `useIsDark()`, not by reading the DOM directly.
- Keep the Vite **dev** proxy and **`preview`** proxy in sync — both are defined in `vite.config.ts`.
