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

  // Injected by Vite `define`: the client version — the Kimi Code CLI version
  // this web bundle ships with (from the kimi-code submodule, see
  // vite.config.ts), NOT apps/web/package.json.
  const __KIMI_CLIENT_VERSION__: string;

  // Injected by Vite `define`: true only in the web bundle embedded in the Kimi
  // Desktop app. Gates the internal-build banner (see InternalBuildBanner.vue).
  const __KIMI_WEB_DESKTOP__: boolean;

  // Injected by Vite `define` (from @moonshot-ai/vite-preset): the bundle's
  // build time (ISO), shown in settings → advanced.
  const __KIMI_BUILD_TIME__: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
