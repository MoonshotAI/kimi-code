import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';
import { kimiRegionSchema } from '@moonshot-ai/kimi-code-oauth';

export const oauthFlowStatusEnum = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);
export type OAuthFlowStatus = z.infer<typeof oauthFlowStatusEnum>;

export const oauthFlowStartPendingSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: z.literal('pending'),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  expires_at: isoDateTimeSchema,
});
export type OAuthFlowStartPending = z.infer<typeof oauthFlowStartPendingSchema>;

export const oauthFlowStartAuthenticatedSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: z.literal('authenticated'),
});
export type OAuthFlowStartAuthenticated = z.infer<typeof oauthFlowStartAuthenticatedSchema>;

export const oauthFlowStartSchema = z.discriminatedUnion('status', [
  oauthFlowStartPendingSchema,
  oauthFlowStartAuthenticatedSchema,
]);
export type OAuthFlowStart = z.infer<typeof oauthFlowStartSchema>;

export const oauthFlowSnapshotSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: oauthFlowStatusEnum,
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  expires_at: isoDateTimeSchema,
  interval: z.number().int().positive(),
  resolved_at: isoDateTimeSchema.optional(),
  error_message: z.string().optional(),
});
export type OAuthFlowSnapshot = z.infer<typeof oauthFlowSnapshotSchema>;

export const oauthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oauthFlowStatusEnum,
});
export type OAuthLoginCancelResponse = z.infer<typeof oauthLoginCancelResponseSchema>;

export const oauthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string().min(1),
});
export type OAuthLogoutResponse = z.infer<typeof oauthLogoutResponseSchema>;

export const oauthRegionResultSchema = z.object({
  region: kimiRegionSchema,
});
export type OAuthRegionResult = z.infer<typeof oauthRegionResultSchema>;

const providerRefreshChangeSchema = z.object({
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});

const providerRefreshFailureSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});

export const refreshOAuthProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshOAuthProviderModelsResponse = z.infer<
  typeof refreshOAuthProviderModelsResponseSchema
>;

export const oauthWorkspaceTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('personal'),
  }),
  z.object({
    kind: z.literal('business'),
    business_id: z.string().trim().min(1),
  }),
]);
export type OAuthWorkspaceTarget = z.infer<typeof oauthWorkspaceTargetSchema>;

export const oauthManagedWorkspaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('personal'),
    key: z.string().min(1),
    name: z.string().min(1),
    current: z.boolean(),
    disabled: z.boolean(),
    switchable: z.boolean(),
    roles: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('business'),
    key: z.string().min(1),
    business_id: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
    current: z.boolean(),
    disabled: z.boolean(),
    switchable: z.boolean(),
    nickname: z.string().optional(),
    roles: z.array(z.string()),
  }),
]);
export type OAuthManagedWorkspace = z.infer<typeof oauthManagedWorkspaceSchema>;

const oauthManagedWorkspacesErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
  error_code: z.string().optional(),
});

export const oauthManagedWorkspacesResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    workspaces: z.array(oauthManagedWorkspaceSchema),
  }),
  oauthManagedWorkspacesErrorSchema,
]);
export type OAuthManagedWorkspacesResult = z.infer<typeof oauthManagedWorkspacesResultSchema>;

export const oauthWorkspaceSwitchResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    provider: z.string().min(1),
    target: oauthWorkspaceTargetSchema,
    warning: z.string().optional(),
  }),
  oauthManagedWorkspacesErrorSchema,
]);
export type OAuthWorkspaceSwitchResponse = z.infer<typeof oauthWorkspaceSwitchResponseSchema>;

export {
  managedUsageResultSchema,
  type ManagedUsageResult,
  managedUserInfoResultSchema,
  type ManagedUserInfoResult,
} from '@moonshot-ai/kimi-code-oauth';
