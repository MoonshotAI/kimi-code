import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const workspaceIdSchema = z
  .string()
  .regex(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/, {
    message: 'workspace_id must be a wd_<slug>_<hash12> string',
  });

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  root: z.string().min(1),
  name: z.string().min(1).max(100),
  is_git_repo: z.boolean(),
  branch: z.string().nullable(),
  created_at: isoDateTimeSchema,
  last_opened_at: isoDateTimeSchema,
  session_count: z.number().int().nonnegative(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});

export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceUpdateSchema = z.object({
  name: z.string().min(1).max(100),
});

export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
