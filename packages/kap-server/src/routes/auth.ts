/**
 * `GET /auth` — readiness probe.
 *
 * Single readiness signal that web/IDE clients hit on first paint to decide
 * between onboarding vs. chat UI. Returns 200 + envelope regardless of provider
 * state.
 *
 * Engine mode: projects readiness from the Rust engine — the engine's parsed
 * config (provider set + default model) — into the v1 `AuthSummary` wire shape
 * (`{ ready, providers_count, default_model, managed_provider }`).
 */

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { authSummarySchema } from '../protocol/rest-auth';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

/** Managed providers are keyed `managed:<name>` in the engine config. A
 *  provider with an inline `apiKey` is authenticated; one configured only for
 *  OAuth (no cached token) is unauthenticated — the engine config carries no
 *  live token state, so this is the closest projection the config surface
 *  supports. */
function findManagedProvider(
  providers: Record<string, unknown>,
): { name: string; status: 'authenticated' | 'unauthenticated' } | null {
  const names = Object.keys(providers).filter((key) => key.startsWith('managed:'));
  if (names.length === 0) return null;
  const name = names[0]!;
  const provider = providers[name] as { apiKey?: unknown } | undefined;
  const apiKey = provider?.apiKey;
  const authenticated = typeof apiKey === 'string' && apiKey.length > 0;
  return { name, status: authenticated ? 'authenticated' : 'unauthenticated' };
}

export function registerAuthRoute(app: RouteHost, rustSession: RustSessionService): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/auth',
      success: { data: authSummarySchema },
      description: 'Get server auth readiness snapshot',
      tags: ['auth'],
    },
    async (req, reply) => {
      // Stage 3e: project readiness from the engine — config's provider set +
      // default model; no v2 authLegacy service and no session dependency
      // (the v1 readiness signal is config-driven).
      const config = (await rustSession.configGet()) as
        | {
            providers?: Record<string, unknown>;
            defaultModel?: string | null;
          }
        | null;
      const providers = config?.providers ?? {};
      const providersCount = Object.keys(providers).length;
      const defaultModel = config?.defaultModel ?? null;
      const managedProvider = findManagedProvider(providers);
      reply.send(
        okEnvelope(
          {
            ready: providersCount > 0 && defaultModel !== null,
            providers_count: providersCount,
            default_model: defaultModel,
            managed_provider: managedProvider,
          },
          req.id,
        ),
      );
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
