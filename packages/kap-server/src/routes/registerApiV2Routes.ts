import type { Scope } from '@moonshot-ai/agent-core-v2';

import { registerV2SessionsRoutes } from './v2/sessions';

interface ApiV2AppHost {
  register(
    plugin: (apiV2: unknown) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

export async function registerApiV2Routes(app: ApiV2AppHost, core: Scope): Promise<void> {
  await app.register(
    async (apiV2) => {
      registerV2SessionsRoutes(apiV2 as Parameters<typeof registerV2SessionsRoutes>[0], core);
    },
    { prefix: '/api/v2' },
  );
}
