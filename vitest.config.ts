import { defineConfig } from 'vitest/config';

// Root test entry (`pnpm test`). Runs only code-app's own packages as vitest
// projects, each loading its own config (plugin pipelines included). The
// `kimi-code/` submodule is intentionally left out: its tests run in its own
// repo/CI and need its own environment.
export default defineConfig({
  test: {
    projects: [
      // apps/* each carry a vitest.config.ts with their renderer plugin set
      // (Vue + unplugin-icons), so `~icons/*` and `?raw` imports resolve.
      'apps/*',
      // app-client and app-composer carry their own vitest.config.ts for the
      // same reason (icon imports pull `~icons/*` virtuals).
      'packages/app-client',
      'packages/app-composer',
      // app-markdown too: codeWrap.ts renders registry icons via iconSvg().
      'packages/app-markdown',
      // The remaining packages/* have no build-time plugin needs; run their
      // tests with the default pipeline from their own roots.
      {
        test: {
          name: 'packages',
          include: ['packages/{app-core,app-i18n,app-ui,vite-preset}/{src,test}/**/*.test.ts'],
        },
      },
    ],
  },
});
