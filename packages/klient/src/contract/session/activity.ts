import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const sessionLatestUpdateSchema = z.object({
  title: z.string(),
  agentId: z.string(),
  source: z.string().optional(),
  at: z.string(),
});

export const sessionActivityStateSchema = z.object({
  busy: z.boolean(),
  mainTurnActive: z.boolean(),
  pendingInteraction: z.enum(['none', 'approval', 'question']),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  latestUpdate: sessionLatestUpdateSchema.optional(),
});

export const sessionActivityViewContract = {
  state: { input: z.tuple([]), output: sessionActivityStateSchema },
} satisfies ServiceContract;
