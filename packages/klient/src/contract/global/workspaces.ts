/**
 * `workspaceService` — process-wide catalog of known workspaces. Mirrors
 * `agent-core-v2/app/workspace/workspace.ts`.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const workspaceSchema = z.object({
  id: z.string(),
  root: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
});

export const workspaceUpdateSchema = z.object({
  name: z.string().optional(),
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
