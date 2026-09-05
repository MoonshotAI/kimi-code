import { z } from 'zod';
import { globalBaseFields } from './base';

export const workspaceInfoSchema = z.object({
  id: z.string(),
  root: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_opened_at: z.string(),
  session_count: z.number(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const workspaceMessageSchema = z.object({
  type: z.literal('workspace'),
  ...globalBaseFields,
  subtype: z.enum(['created', 'updated', 'deleted']),
  workspace: workspaceInfoSchema,
});
export type WorkspaceMessage = z.infer<typeof workspaceMessageSchema>;
