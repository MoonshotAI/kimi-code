/// <reference types="vite/client" />

// `~icons/*?raw` module declarations live in the shared preset.
import '@moonshot-ai/vite-preset/icons';

declare global {
  // Injected by Vite `define` (see vite.config.ts): this bundle never ships
  // inside the desktop app.
  const __KIMI_WEB_DESKTOP__: boolean;

  // Injected by Vite `define` (from @moonshot-ai/vite-preset): bundle build
  // time (ISO). Declared for shared sources that may reference it.
  const __KIMI_BUILD_TIME__: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
