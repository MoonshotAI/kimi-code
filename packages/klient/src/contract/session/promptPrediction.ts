import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const promptPredictionInputSchema = z.object({
  predictionId: z.string().min(1),
  expectedTurnId: z.number().int().nonnegative(),
});

export const promptPredictionCancelInputSchema = z.string().min(1);

export const sessionPromptPredictionContract = {
  predict: {
    input: z.tuple([promptPredictionInputSchema]),
    output: z.string().nullable(),
  },
  cancel: {
    input: z.tuple([promptPredictionCancelInputSchema]),
    output: z.boolean(),
  },
} satisfies ServiceContract;
