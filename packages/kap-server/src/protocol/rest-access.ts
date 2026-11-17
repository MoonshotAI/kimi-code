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
