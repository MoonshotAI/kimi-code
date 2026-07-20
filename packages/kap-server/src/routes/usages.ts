/**
 * `GET /usages` — managed plan quota snapshot.
 *
 * Returns the 5h/weekly rolling-window limits (plus the booster wallet) for
 * the managed Kimi provider, so web/IDE clients can render a persistent quota
 * indicator without shelling out to the CLI. The data comes from the platform
 * `GET /usages` endpoint via `IOAuthToolkit.getManagedUsage`, already parsed
 * into the `ParsedManagedUsage` shape (`summary` = weekly, `limits[]` = the
 * window limits incl. the 5h one).
 *
 * When the active provider is not the managed one (or the user is signed
 * out), the toolkit call fails and the route returns the error message inside
 * a success envelope with a `kind: 'error'` marker — clients render the
 * message instead of percentages. This mirrors the CLI footer, which shows
 * `quota: <error>` rather than failing the whole panel.
 */

import { IOAuthToolkit, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

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

const usageRowSchema = z.object({
  label: z.string(),
  used: z.number(),
  limit: z.number(),
  resetHint: z.string().optional(),
});

const boosterWalletSchema = z.object({
  balanceCents: z.number(),
  totalCents: z.number(),
  monthlyChargeLimitEnabled: z.boolean(),
  monthlyChargeLimitCents: z.number(),
  monthlyUsedCents: z.number(),
  currency: z.string(),
});

const managedUsageOkSchema = z.object({
  kind: z.literal('ok'),
  summary: usageRowSchema.nullable(),
  limits: z.array(usageRowSchema),
  extraUsage: boosterWalletSchema.nullable(),
});

const managedUsageErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
});

const managedUsageResultSchema = z.union([managedUsageOkSchema, managedUsageErrorSchema]);

export function registerUsagesRoute(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/usages',
      success: { data: managedUsageResultSchema },
      description: 'Get managed plan quota (5h/weekly windows)',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await core.accessor.get(IOAuthToolkit).getManagedUsage();
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
