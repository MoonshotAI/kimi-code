/**
 * `providerDiscovery` — the engine's `IProviderDiscoveryService`: remote
 * provider-model discovery and config sync. Mirrors
 * `agent-core-v2/app/kosongConfig/discovery.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const refreshProviderModelsOptionsSchema = z.object({
  scope: z.enum(['all', 'oauth']).optional(),
  providerId: z.string().optional(),
});

/** Same shape as `refreshOAuthProviderModelsResponseSchema` in `./auth.js`, plus the
 * optional `retired_default` the OAuth-only login refresh never produces. */
export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
  retired_default: z
    .object({
      from: z.string(),
      to: z.string(),
      from_display_name: z.string(),
    })
    .optional(),
});

export const providerDiscoveryContract = {
  refreshProviderModels: {
    input: z.tuple([refreshProviderModelsOptionsSchema.optional()]),
    output: refreshProviderModelsResponseSchema,
  },
} satisfies ServiceContract;
