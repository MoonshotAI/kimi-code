/**
 * `oauthService` + `authSummaryService` — app-scope OAuth flow and auth
 * summary. Mirrors `agent-core-v2/app/auth/auth.ts`; wire shapes mirror
 * `protocol/src/rest/oauth.ts` (snake_case fields). `resolveTokenProvider`
 * and `getCachedAccessToken` are excluded (non-serializable).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const oAuthFlowStatusSchema = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);

export const oAuthFlowStartSchema = z.discriminatedUnion('status', [
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('pending'),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    user_code: z.string(),
    expires_in: z.number(),
    interval: z.number(),
    expires_at: z.string(),
  }),
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('authenticated'),
  }),
]);

export const oAuthFlowSnapshotSchema = z.object({
  flow_id: z.string(),
  provider: z.string(),
  status: oAuthFlowStatusSchema,
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  user_code: z.string(),
  expires_in: z.number(),
  expires_at: z.string(),
  interval: z.number(),
  resolved_at: z.string().optional(),
  error_message: z.string().optional(),
});

export const oAuthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oAuthFlowStatusSchema,
});

export const oAuthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string(),
});

export const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  provider: z.string().optional(),
});

/** Same shape as `refreshProviderModelsResponseSchema` in `./catalog.js` — keep in sync. */
export const refreshOAuthProviderModelsResponseSchema = z.object({
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
});

export const authContract = {
  startLogin: { input: z.tuple([z.string().optional()]), output: oAuthFlowStartSchema },
  getFlow: {
    input: z.tuple([z.string().optional()]),
    output: maybe(oAuthFlowSnapshotSchema),
  },
  cancelLogin: {
    input: z.tuple([z.string().optional()]),
    output: oAuthLoginCancelResponseSchema,
  },
  logout: { input: z.tuple([z.string().optional()]), output: oAuthLogoutResponseSchema },
  status: { input: z.tuple([z.string().optional()]), output: authStatusSchema },
  refreshOAuthProviderModels: {
    input: z.tuple([]),
    output: refreshOAuthProviderModelsResponseSchema,
  },
} satisfies ServiceContract;

export const authSummaryContract = {
  summarize: { input: z.tuple([]), output: z.array(authStatusSchema) },
  ensureReady: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;
