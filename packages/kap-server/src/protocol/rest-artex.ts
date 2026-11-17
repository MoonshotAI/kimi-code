import { z } from 'zod';

export const artexControlBodySchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'rerun_blocked']),
  exploration_id: z.number().int().positive().optional(),
});

export const artexStartBodySchema = z
  .object({
    goal: z.string().min(1),
    description: z.string().optional(),
    exploration_id: z.number().int().positive().optional(),
    scope: z.array(z.unknown()).optional(),
    constraints: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const artexWorkspaceQuerySchema = z.object({
  workspace_id: z.string().optional(),
  cwd: z.string().optional(),
});

export const artexExportQuerySchema = z.object({
  format: z.enum(['markdown', 'json', 'csv']).default('markdown'),
  exploration_id: z.coerce.number().int().positive().optional(),
});