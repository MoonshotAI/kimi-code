/**
 *   POST   /v1/oauth/login
 *   GET    /v1/oauth/login
 *   POST   /v1/oauth/logout
 *
 * Request-side query/body schemas for the OAuth routes. The response shapes are
 * owned by the engine (`app/auth/oauthProtocol`).
 */

import { z } from 'zod';

export const oauthLoginStartRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginStartRequest = z.infer<typeof oauthLoginStartRequestSchema>;

export const oauthLoginQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginQuery = z.infer<typeof oauthLoginQuerySchema>;

export const oauthLogoutRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLogoutRequest = z.infer<typeof oauthLogoutRequestSchema>;
