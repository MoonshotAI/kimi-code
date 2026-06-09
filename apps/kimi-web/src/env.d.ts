/// <reference types="vite/client" />

// Injected by Vite `define` (see vite.config.ts): the dev proxy's upstream
// daemon target, so the UI can display which daemon it actually talks to.
// In production builds this is still defined but unused (same-origin daemon).
declare const __KIMI_DEV_PROXY_TARGET__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
