import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const projectFields = {
  id: z.string(),
  root: z.string(),
  name: z.string(),
  additionalDirs: z.array(z.string()),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
};

export const workspaceSchema = z.discriminatedUnion('kind', [
  z.object({ ...projectFields, kind: z.literal('managed'), vcs: z.never().optional() }),
  z.object({ ...projectFields, kind: z.literal('implicit'), vcs: z.object({ type: z.literal('git'), store: z.string() }).optional() }),
]);

export const workspaceUpdateSchema = z.object({
  name: z.string().optional(),
  additionalDirs: z.array(z.string()).optional(),
});

export const workspacesContract = {
  list: { input: z.tuple([]), output: z.array(workspaceSchema) },
  get: { input: z.tuple([z.string()]), output: maybe(workspaceSchema) },
  createOrTouch: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: workspaceSchema,
  },
  update: {
    input: z.tuple([z.string(), workspaceUpdateSchema]),
    output: maybe(workspaceSchema),
  },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
