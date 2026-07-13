/// <reference types="vite/client" />

// Injected by Vite `define` (see vite.config.ts): the dev proxy's upstream
// daemon target, so the UI can display which daemon it actually talks to.
// In production builds this is still defined but unused (same-origin daemon).
declare const __KIMI_DEV_PROXY_TARGET__: string;

// Injected by Vite `define` (see vite.config.ts): the named dev-proxy backend
// presets (default = kap-server on 58627, multi = extra kap-server instance on
// 58628) for the Sidebar switcher menu. The live target comes from
// GET /__kimi-dev/backend; this is the synchronous initial value. Unused by
// the same-origin production build.
declare const __KIMI_DEV_BACKENDS__: { default: string; multi: string };

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

// Vite's `?worker&type=module` imports — not declared in `vite/client`,
// which only covers `?worker`, `?worker&inline`, and `?worker&url` for classic
// workers. ES module workers need this additional declaration so TypeScript
// can resolve the import without errors.
declare module '*?worker&type=module' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

// unplugin-icons `?raw` imports — `unplugin-icons/types/vue` declares
// `~icons/*` as a Vue FunctionalComponent (for direct component imports). The
// `?raw` query re-exports the raw SVG source, which must type as `string`;
// this more-specific pattern overrides the component declaration for `?raw`
// imports only (e.g. `~icons/ri/add-line?raw`), leaving component imports
// (`~icons/ri/add-line`) typed as components.
declare module '~icons/*?raw' {
  const src: string;
  export default src;
}
