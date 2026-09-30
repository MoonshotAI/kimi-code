import { useApp } from '@moonshot-ai/agent-core';

import { useHttpRoute } from '../feature';
import { sendOk } from '../route/http';

export function useShutdownRoutes(prefix: string): void {
  useHttpRoute({
    id: 'shutdown',
    method: 'POST',
    path: `${prefix}/shutdown`,
    handler: (request, response) => {
      const app = useApp();
      sendOk(request, response, { ok: true });
      setImmediate(() => {
        void app.close().catch(() => {});
      });
    },
  });
}
