import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';

export function useHealthRoutes(prefix: string): void {
  useHttpRoute({
    id: 'healthz',
    method: 'GET',
    path: `${prefix}/healthz`,
    handler: (request, response) => {
      sendOk(request, response, { ok: true });
    },
  });
}
