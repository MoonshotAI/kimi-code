/// <reference types="vite/client" />

import '@moonshot-ai/vite-preset/icons';

declare global {
  const __KIMI_CODE_DESKTOP__: boolean;

  const __KIMI_BUILD_TIME__: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
