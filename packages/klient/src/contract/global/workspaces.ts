import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const workspaceSchema = z.object({
  id: z.string(),
  root: z.string(),
  name: z.string(),
  kind: z.enum(['managed', 'implicit']),
  additionalDirs: z.array(z.string()),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
});

export const implicitWorkspaceSchema = workspaceSchema.extend({ kind: z.literal('implicit') });

export const implicitProjectResultSchema = z.object({
  project: implicitWorkspaceSchema,
  rule: z.enum(['sticky', 'repo', 'own']),
});

export const workspaceUpdateSchema = z.object({
  name: z.string().optional(),
  additionalDirs: z.array(z.string()).optional(),
});

export const workspacesContract = {
  list: { input: z.tuple([]), output: z.array(workspaceSchema) },
  get: { input: z.tuple([z.string()]), output: maybe(workspaceSchema) },
  resolveImplicit: {
    input: z.tuple([z.string()]),
    output: implicitProjectResultSchema,
  },
  update: {
    input: z.tuple([z.string(), workspaceUpdateSchema]),
    output: maybe(workspaceSchema),
  },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
