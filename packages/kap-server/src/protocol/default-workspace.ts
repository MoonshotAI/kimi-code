import { z } from 'zod';

export const defaultWorkspaceUnavailableReasonSchema = z.enum([
  'blocked_by_file',
  'permission_denied',
  'missing_parent',
  'no_space',
  'read_only',
  'invalid_path',
  'unknown',
]);

export const defaultWorkspaceUnavailableDataSchema = z.object({
  path: z.string(),
  reason: defaultWorkspaceUnavailableReasonSchema,
});
