import { z } from 'zod';

import { globalMessageBase, isoDateTimeSchema } from './base';

export const workspaceIdSchema = z
  .string()
  .regex(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/, {
    message: 'workspace_id must be a wd_<slug>_<hash12> string',
  });

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceInfoSchema = z.object({
  id: workspaceIdSchema,
  root: z.string().min(1),
  name: z.string().min(1).max(100),
  created_at: isoDateTimeSchema,
  last_opened_at: isoDateTimeSchema,
  session_count: z.number().int().nonnegative(),
});

export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const workspaceMessageSchema = z.object({
  type: z.literal('workspace'),
  ...globalMessageBase,
  subtype: z.enum(['created', 'updated', 'deleted']),
  workspace: workspaceInfoSchema,
});

export type WorkspaceMessage = z.infer<typeof workspaceMessageSchema>;
