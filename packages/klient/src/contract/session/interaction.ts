/**
 * `sessionInteractionService` — blocking human-in-the-loop request kernel.
 * Mirrors `agent-core-v2/session/interaction/interaction.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const interactionKindSchema = z.enum(['approval', 'question', 'user_tool']);

export const interactionOriginSchema = z.object({
  agentId: z.string().optional(),
  turnId: z.number().optional(),
});

export const interactionSchema = z.object({
  id: z.string(),
  kind: interactionKindSchema,
  payload: z.unknown(),
  origin: interactionOriginSchema,
  createdAt: z.number(),
});

export const interactionResolutionSchema = z.object({
  id: z.string(),
  response: z.unknown(),
});

export const sessionInteractionContract = {
  listPending: {
    input: z.tuple([interactionKindSchema.optional()]),
    output: z.array(interactionSchema),
  },
  respond: { input: z.tuple([z.string(), z.unknown()]), output: noResult },
  isRecentlyResolved: { input: z.tuple([z.string()]), output: z.boolean() },
} satisfies ServiceContract;
