/// <reference types="vite/client" />

// Injected by Vite `define` (see vite.config.ts): the dev proxy's upstream
// daemon target, so the UI can display which daemon it actually talks to.
// In production builds this is still defined but unused (same-origin daemon).
declare const __KIMI_DEV_PROXY_TARGET__: string;

// Injected by Vite `define` from apps/kimi-web/package.json.
declare const __KIMI_WEB_VERSION__: string;

// Injected by Vite `define`: true only in the web bundle embedded in the Kimi
// Desktop app. Gates the internal-build banner (see InternalBuildBanner.vue).
declare const __KIMI_WEB_DESKTOP__: boolean;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
