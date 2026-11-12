import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const promptPredictionInputSchema = z.object({
  predictionId: z.string().min(1),
  expectedTurnId: z.number().int().nonnegative(),
});

export const promptPredictionCancelInputSchema = z.string().min(1);

export const promptPredictionCancelReasonSchema = z.enum([
  'input',
  'escape',
  'new_turn',
  'session',
  'dialog',
  'queue',
  'submit',
  'plan',
  'visibility',
  'shutdown',
  'disconnect',
  'activity_turn_started',
  'activity_turn_ended',
  'activity_background',
  'activity_interaction',
  'activity_agent_lifecycle',
  'agent_will_close',
  'agent_replaced',
  'agent_closed',
  'disposed',
  'unspecified',
]);

export const sessionPromptPredictionContract = {
  predict: {
    input: z.tuple([promptPredictionInputSchema]),
    output: z.string().nullable(),
  },
  cancel: {
    input: z.tuple([promptPredictionCancelInputSchema, promptPredictionCancelReasonSchema.optional()]),
    output: z.boolean(),
  },
} satisfies ServiceContract;
