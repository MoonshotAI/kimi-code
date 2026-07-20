/**
 * `/api/v1/debug` route registration — the RPC surface.
 *
 * Mounts the reflection dispatcher (`registerServiceDispatcherRoutes`) with a
 * channel lookup spanning the whole scoped DI registry, so EVERY Service
 * (App/Session/Agent scope) is callable. Access is gated by deployment shape
 * rather than a surface whitelist:
 *
 * - mounted only when `--debug-endpoints` is passed AND the bind is loopback
 *   (the AND happens in `start.ts`; this module trusts that gate);
 * - still behind the global bearer-auth hook like every `/api/*` route.
 *
 * Called from `registerApiV1Routes` with the prefixed `/api/v1` route host,
 * so the base path here is relative: `/debug`.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';

import { describeAllChannels, resolveAnyScopedServiceId } from './channelRegistry';
import { type RouteHost, registerServiceDispatcherRoutes } from './serviceDispatcherRoutes';

export function registerDebugRoutes(app: RouteHost, core: Scope): void {
  registerServiceDispatcherRoutes(app, core, '/debug', {
    lookup: resolveAnyScopedServiceId,
    describe: describeAllChannels,
  });
}
