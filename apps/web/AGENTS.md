# kimi-web Agent Guide

Package-local rules for `apps/kimi-web` (`kimi-code-web`).

## What it is

The browser web UI for Kimi Code — a peer to the TUI in `apps/kimi-code`. It talks to the local server over REST + WebSocket under `/api/v1`. Stack: Vue 3 + Vite 6 + TypeScript (strict) + vue-i18n v11. (Tailwind was removed; all styling is via design tokens in `src/style.css` + scoped component styles.) There is no client router and no Pinia; state lives in composables/refs and provide/inject.

## Design system (normative — required when modifying the UI)

- **Before changing any component, style, layout, or theme, read the design system view at `src/views/DesignSystemView.vue` (open it as an overlay: long-press the sidebar logo).** It is the canonical design system and visual spec for this app (tokens §02, primitives §03, chat §04, theme rules §05, style rules §06). It consumes the product tokens from `src/style.css` directly, so it stays in sync with the app. New and modified UI must match it.
- **Use the primitives from `@moonshot-ai/app-ui`** (source in `packages/app-ui`; import as `import { Button, Icon, … } from '@moonshot-ai/app-ui'`, and the app's `src/style.css` imports `@moonshot-ai/app-ui/style.css` for the tokens plus `@moonshot-ai/app-ui/fonts.css` for the self-hosted fonts — a page that only needs tokens may import `style.css` alone). The library covers Button, IconButton, Badge, Pill, Card, Input/Select/Textarea/Field, Dialog, Spinner, Link, Menu/MenuItem, SegmentedControl, Tabs, Switch, Checkbox, Avatar, EmptyState, Divider, Tooltip, Banner, Sheet, Skeleton, CommandBar, TopBar. One semantic = one component — do not hand-roll a bespoke button/badge/dialog/input for a single screen. When a primitive replaces an element, **delete the old scoped CSS** (do not append override blocks).
- **Use the tokens, not ad-hoc values.** Colors, fonts, radii, spacing, shadows, z-index, and motion come from the CSS custom properties in `src/style.css` (catalogued in the design-system view §02). Canonical names are `--color-*` / `--radius-*` / `--space-*` / `--text-*` / `--font-*` / `--z-*` / `--shadow-*` / `--ease-*` / `--duration-*` / `--weight-*` / `--leading-*`, plus `--anim-*` for the designer-exported icon animation tracks (§02 Motion; verbatim Rive timings, intentionally outside the `--duration-*` ramp). A small set of layout/focus tokens keep the `--p-` prefix: `--p-focus-ring`, `--p-selection`, `--p-ic-sm/md/lg`, `--p-sidebar-w`, `--p-content-max/-wide`, `--p-table-max/-cell-max`, `--p-findbar-w`, `--p-findring-w`, `--p-hairline`, `--p-bp-sm/-md`.
- **The chat working indicator (小蓝 mascot + phase label) is reserved** for the chat working state after a prompt is sent only, and is rendered solely by `chat/WorkingIndicator.vue`; every other loading state uses the plain `Spinner`.
- **Run `pnpm --filter kimi-code-web check:style`** (`scripts/check-style.mjs`) — it enforces the §06 anti-pattern rules (no-gradient, no-glassmorphism except TopBar `frost` and the whitelisted menu surfaces via the `--p-menu-backdrop` token, no-emoji-icon, no-hardcoded-hex/font, radius/z/weight from scale). Do not add new violations.
- **Verify visually.** For any UI change, render it in the browser (light + dark, plus hover/focus states) and confirm it matches the design-system view and introduces no regression before considering it done. Build/typecheck/check-style are necessary but not sufficient.

## Layout (`src/`)

- `main.ts` — bootstrap (creates the app, installs i18n, mounts `#app`). `App.vue` — root component, holds most app state.
- `api/` — app-side wiring only: `bootstrap.ts` composes the shared `createKimiWebApi` factory (from `@moonshot-ai/app-core/api`) with this app's tracer / credential store / runtime config / i18n `t`; `index.ts` exposes the `getKimiWebApi()` singleton; `config.ts` reads `window` / `import.meta.env` / sessionStorage for origin and identity; `types.ts` / `errors.ts` are re-export shells. The transport, wire types, mappers, event reducer, and agent event projector all live in `@moonshot-ai/app-core/api` so web + desktop share one implementation.
- `components/` — SFCs grouped by area: `chat/` (conversation/chat UI), `settings/` (settings & configuration), `dialogs/` (modal dialogs & sheets), `mobile/` (mobile-specific shell), plus shared layout components at the top level. The design-system primitives formerly under `components/ui/` now live in the `@moonshot-ai/app-ui` package (see "Design system" above).
- `composables/` — app-side composables that remain here (`useDialogFocus`, …). The client singletons (`useKimiWebClient`, `useWorkspaceState`, `client/*`) live in `@moonshot-ai/app-client/client`; their platform seams (api / translator / tracer / optional desktop hooks) are registered via `setKimiClientDeps` in `main.ts`. Shared, non-diverged composables (`useIsMobile`, `useFilePreview`, `useDetailPanel`, …) live in `@moonshot-ai/app-client/composables` and take api / translator / tracker by injection — new shared composables go there, not here.
- `lib/` — app-side helpers that remain here (`toolMeta` / `activitySummary` shells, …). Shared pure helpers live in `@moonshot-ai/app-core/lib`; rendering types and hot-path pure modules (turns projection, diff builders, event batching) in `@moonshot-ai/app-core/client`; the icon registry + `kimi` SVG assets and browser-layer helpers (`mediaPreview`, `openFileAttachment`) in `@moonshot-ai/app-client` (`./icons` / `./lib`).
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

All via `pnpm --filter kimi-code-web …`:

- `dev` — Vite dev server (port `WEB_PORT`, default 5175; proxies `/api/v1` to `KIMI_SERVER_URL`, default `http://127.0.0.1:58627`).
- `dev:stub` — offline stub daemon (`dev/stub-daemon.mjs`).
- `build` — production build into `dist/`.
- `typecheck` — `vue-tsc --noEmit`.
- `test` — `vitest run` (pure logic tests only; no jsdom / component tests).
- `check:style` — design-system §06 anti-pattern guard (`scripts/check-style.mjs`).
- There is **no `lint` script** in this package; linting runs at the repo root via oxlint.

## Gotchas / hard rules

- **Do not depend on `@moonshot-ai/agent-core`** (mirrors the CLI/SDK rule). The web app is decoupled from core/protocol; wire types are maintained in `@moonshot-ai/app-core/api` (`daemon/wire.ts`). Keep it that way.
- **Same-origin by default:** the browser only talks to its own origin; Vite proxies `/api/v1` for both HTTP and WS. Set `VITE_KIMI_SERVER_HTTP_URL` only when you intentionally want direct (CORS) mode.
- Vite-injected globals (`__KIMI_DEV_PROXY_TARGET__`, `__KIMI_CLIENT_VERSION__`) are declared in `src/env.d.ts` and defined in `vite.config.ts`. Do not hand-edit `dist/`.
- **Theming:** the root element carries `data-color-scheme` (`light` | `dark` | `system`); react to it through `useIsDark()`, not by reading the DOM directly.
- Keep the Vite **dev** proxy and **`preview`** proxy in sync — both are defined in `vite.config.ts`.
