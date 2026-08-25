/// <reference types="vite/client" />

// Shared ambient module declarations for unplugin-icons `?raw` and Vite
// `?worker&type=module` imports live in `@moonshot-ai/vite-preset` so the web
// and desktop renderers stay in sync.
import '@moonshot-ai/vite-preset/icons';
import '@moonshot-ai/vite-preset/worker';

declare global {
  // Injected by Vite `define` (see vite.config.ts): the dev proxy's upstream
  // daemon target, so the UI can display which daemon it actually talks to.
  // In production builds this is still defined but unused (same-origin daemon).
  const __KIMI_DEV_PROXY_TARGET__: string;

  // Injected by Vite `define`: the named dev-backend presets offered by the dev
  // backend switcher (see api/devBackend.ts). Absent when the switcher's Vite
  // plugin is not mounted.
  const __KIMI_DEV_BACKENDS__: { default: string; multi: string };

  // Injected by Vite `define`: the client version, from apps/desktop/package.json
  // (see vite.renderer.config.ts).
  const __KIMI_CLIENT_VERSION__: string;

  // Injected by Vite `define`: true only in the web bundle embedded in the Kimi
  // Code desktop app. Gates desktop-only behaviour (see lib/desktopFlag.ts).
  const __KIMI_WEB_DESKTOP__: boolean;

  // Injected by Vite `define` (from @moonshot-ai/vite-preset): the bundle's
  // build time (ISO), shown in settings → advanced.
  const __KIMI_BUILD_TIME__: string;

  // Injected by Vite `define` (from @moonshot-ai/vite-preset): the bundle's
  // source commit (full sha; '' when git is unavailable).
  const __KIMI_COMMIT_SHA__: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
