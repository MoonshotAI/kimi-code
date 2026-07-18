/**
 * `sessionMetadata` — typed session metadata. Mirrors
 * `agent-core-v2/session/sessionMetadata/sessionMetadata.ts`. The `ready`
 * promise property is excluded (not a wire method).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const agentMetaSchema = z.object({
  homedir: z.string().optional(),
  type: z.enum(['main', 'sub', 'independent']).optional(),
  parentAgentId: z.union([z.string(), z.null()]).optional(),
  forkedFrom: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  swarmItem: z.string().optional(),
});

export const sessionMetaSchema = z.object({
  id: z.string(),
  version: z.number().optional(),
  title: z.string().optional(),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  cwd: z.string().optional(),
  forkedFrom: z.string().optional(),
  agents: z.record(z.string(), agentMetaSchema).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

/** `Partial<Omit<SessionMeta, 'id' | 'createdAt'>>` — every key optional. */
export const sessionMetaPatchSchema = z.object({
  version: z.number().optional(),
  title: z.string().optional(),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  updatedAt: z.number().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
  forkedFrom: z.string().optional(),
  agents: z.record(z.string(), agentMetaSchema).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

/** `keyof SessionMeta` — keep in sync with `sessionMetaSchema`. */
export const sessionMetaKeySchema = z.enum([
  'id',
  'version',
  'title',
  'isCustomTitle',
  'lastPrompt',
  'createdAt',
  'updatedAt',
  'archived',
  'cwd',
  'forkedFrom',
  'agents',
  'custom',
]);

export const sessionMetadataChangedEventSchema = z.object({
  changed: z.array(sessionMetaKeySchema),
});

export const sessionMetadataContract = {
  read: { input: z.tuple([]), output: sessionMetaSchema },
  update: { input: z.tuple([sessionMetaPatchSchema]), output: noResult },
  setTitle: { input: z.tuple([z.string()]), output: noResult },
  setArchived: { input: z.tuple([z.boolean()]), output: noResult },
  registerAgent: { input: z.tuple([z.string(), agentMetaSchema]), output: noResult },
} satisfies ServiceContract;
