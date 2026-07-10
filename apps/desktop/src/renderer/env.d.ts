/// <reference types="vite/client" />

// Shared ambient module declarations for unplugin-icons `?raw` and Vite
// `?worker&type=module` imports live in `@moonshot-ai/vite-preset` so the web
// and desktop renderers stay in sync.
import '@moonshot-ai/vite-preset/icons';
import '@moonshot-ai/vite-preset/worker';

declare global {
  // Injected by Vite `define` (see vite.renderer.config.ts): true for the
  // desktop renderer bundle. Gates desktop-only branches. Note: the desktop
  // config deliberately does NOT define `__KIMI_DEV_PROXY_TARGET__` — the
  // desktop renderer talks to the loopback server directly, never via the web
  // dev proxy.
  const __KIMI_DESKTOP__: boolean;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
