import { useApp } from '@moonshot-ai/agent-core/app/index';

import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';

export function useShutdownRoutes(prefix: string): void {
  const app = useApp();
  useHttpRoute({
    id: 'shutdown',
    method: 'POST',
    path: `${prefix}/shutdown`,
    handler: (request, response) => {
      sendOk(request, response, { ok: true });
      setImmediate(() => {
        void app.close().catch(() => {});
      });
    },
  });
}
