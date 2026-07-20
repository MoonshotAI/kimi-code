/**
 * `/api/v1/debug` route registration — the dev-only, whitelist-free RPC
 * surface.
 *
 * Same dispatcher and envelope semantics as `/api/v2`
 * (`registerServiceDispatcherRoutes`), but the channel lookup spans the whole
 * scoped DI registry, so EVERY Service (App/Session/Agent scope) is callable,
 * not just the `/api/v2` whitelist. Intended for dev tooling (kimi-inspect),
 * never for production clients:
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
import { type RouteHost, registerServiceDispatcherRoutes } from './registerRpcRoutes';

export function registerDebugRoutes(app: RouteHost, core: Scope): void {
  registerServiceDispatcherRoutes(app, core, '/debug', {
    lookup: resolveAnyScopedServiceId,
    describe: describeAllChannels,
  });
}
