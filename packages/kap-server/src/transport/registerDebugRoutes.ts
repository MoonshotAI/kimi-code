import type { Scope } from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../envelope';
import { getRequestPrincipal } from '../middleware/auth';
import { ErrorCode } from '../protocol/error-codes';
import { registerBusinessSnapshotRoutes } from './businessSnapshotRoutes';
import { describeAllChannels, resolveAnyScopedServiceId } from './channelRegistry';
import { type RouteHost, registerServiceDispatcherRoutes } from './serviceDispatcherRoutes';

export function registerDebugRoutes(app: RouteHost, core: Scope): void {
  const guard = <TReq extends { readonly id: string }, TReply>(
    handler: (req: TReq, reply: TReply) => Promise<unknown>,
  ) => {
    return async (req: TReq, reply: TReply) => {
      if (getRequestPrincipal(req).role !== 'owner') {
        const r = reply as unknown as {
          code?(status: number): { send(payload: unknown): unknown };
          status?(status: number): { send(payload: unknown): unknown };
        };
        const payload = errEnvelope(
          ErrorCode.ACCESS_FORBIDDEN,
          'Insufficient token permissions',
          req.id,
        );
        if (typeof r.code === 'function') return r.code(403).send(payload);
        if (typeof r.status === 'function') return r.status(403).send(payload);
      }
      return handler(req, reply);
    };
  };
  const guardedHost: RouteHost = {
    get: (path, optionsOrHandler, maybeHandler) => {
      const h = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler!;
      return app.get(path, { schema: { hide: true } }, guard(h));
    },
    post: (path, optionsOrHandler, maybeHandler) => {
      const h = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler!;
      return app.post(path, { schema: { hide: true } }, guard(h));
    },
  };
  registerServiceDispatcherRoutes(guardedHost, core, '/debug', {
    lookup: (name) => resolveAnyScopedServiceId(core, name),
    describe: describeAllChannels,
  });
  registerBusinessSnapshotRoutes(guardedHost, core, '/debug');
}
