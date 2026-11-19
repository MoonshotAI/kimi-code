/// <reference types="vite/client" />

import '@moonshot-ai/vite-preset/icons';
import '@moonshot-ai/vite-preset/worker';

declare global {
  const __KIMI_DEV_PROXY_TARGET__: string;

  const __KIMI_DEV_BACKENDS__: { default: string; multi: string };

  const __KIMI_CLIENT_VERSION__: string;

  const __KIMI_CORE_REF__: string;

  const __KIMI_CODE_DESKTOP__: boolean;

  const __KIMI_BUILD_TIME__: string;

  const __KIMI_COMMIT_SHA__: string;

  const __KIMI_BRANCH__: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
