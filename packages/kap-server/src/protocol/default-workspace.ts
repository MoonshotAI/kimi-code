import { z } from 'zod';

export const defaultWorkspaceUnavailableReasonSchema = z.enum([
  'blocked_by_file',
  'permission_denied',
  'missing_parent',
  'no_space',
  'read_only',
  'invalid_path',
  'documents_unavailable',
  'unknown',
]);

export const defaultWorkspaceUnavailableDataSchema = z.object({
  path: z.string().nullable(),
  reason: defaultWorkspaceUnavailableReasonSchema,
});

export const defaultWorkspaceStatusSchema = z.object({
  path: z.string().nullable(),
  custom_path: z.string().nullable(),
  system_path: z.string().nullable(),
  exists: z.boolean(),
  problem: defaultWorkspaceUnavailableReasonSchema.nullable(),
});

export type DefaultWorkspaceStatusWire = z.infer<typeof defaultWorkspaceStatusSchema>;

export const updateDefaultWorkspaceRequestSchema = z.object({
  path: z.string().nullable(),
});
