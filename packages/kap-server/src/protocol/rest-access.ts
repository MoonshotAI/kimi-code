import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const accessRoleSchema = z.enum(['viewer', 'operator', 'owner']);
export const externalAccessRoleSchema = z.enum(['viewer', 'operator']);

export const accessMeResponseSchema = z.object({
  role: accessRoleSchema,
  principal_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export type AccessMeResponse = z.infer<typeof accessMeResponseSchema>;

export const accessPrincipalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: externalAccessRoleSchema,
  created_at: isoDateTimeSchema,
  last_used_at: isoDateTimeSchema.nullable(),
  revoked_at: isoDateTimeSchema.nullable(),
});

export type AccessPrincipalWire = z.infer<typeof accessPrincipalSchema>;

export const listAccessPrincipalsResponseSchema = z.object({
  items: z.array(accessPrincipalSchema),
});

export const revokeAccessPrincipalResponseSchema = z.object({
  principal: accessPrincipalSchema,
});

export const createAccessRequestBodySchema = z.object({
  client_name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((v) => !/[\u0000-\u001F\u007F-\u009F]/.test(v), {
      message: 'client_name must not contain control characters',
    }),
  role: externalAccessRoleSchema,
});

export const createAccessRequestResponseSchema = z.object({
  request_id: z.string().min(1),
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  expires_at: isoDateTimeSchema,
});

export const accessRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
]);

export const accessRequestViewSchema = z.object({
  request_id: z.string().min(1),
  client_name: z.string().min(1),
  role: externalAccessRoleSchema,
  user_code: z.string().min(1),
  status: accessRequestStatusSchema,
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
  resolved_at: isoDateTimeSchema.optional(),
});

export const resolveAccessRequestBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

export const resolveAccessRequestResponseSchema = z.object({
  request: accessRequestViewSchema,
});

export const exchangeAccessRequestBodySchema = z.object({
  device_code: z.string().min(1),
});

export const exchangeAccessRequestResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    expires_at: isoDateTimeSchema,
  }),
  z.object({
    status: z.literal('rejected'),
  }),
  z.object({
    status: z.literal('expired'),
  }),
  z.object({
    status: z.literal('approved'),
    token: z.string().min(1),
    role: externalAccessRoleSchema,
    principal_id: z.string().min(1),
  }),
]);
