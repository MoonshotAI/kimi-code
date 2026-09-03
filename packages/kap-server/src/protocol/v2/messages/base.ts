import { z } from 'zod';

export const timestampSchema = z.string();

export const timelineBaseFields = {
  session_id: z.string(),
  agent_id: z.string(),
  timestamp: timestampSchema,
};

export const sessionBaseFields = {
  session_id: z.string(),
  timestamp: timestampSchema,
};

export const globalBaseFields = {
  timestamp: timestampSchema,
};

export const stepUsageSchema = z.object({
  input_other: z.number(),
  output: z.number(),
  input_cache_read: z.number(),
  input_cache_creation: z.number(),
});
export type StepUsage = z.infer<typeof stepUsageSchema>;

export const turnUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  cost: z.number().optional(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;
