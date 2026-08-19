import { z } from 'zod';

export const oauthLoginStartRequestSchema = z.object({
  provider: z.string().min(1).optional(),
  region: z.enum(['mainland-cn', 'global']).optional(),
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
