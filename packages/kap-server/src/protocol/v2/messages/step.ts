import { z } from 'zod';
import { stepUsageSchema, timelineBaseFields } from './base';

export const stepRetrySchema = z.object({
  failed_attempt: z.number(),
  next_attempt: z.number(),
  max_attempts: z.number(),
  delay_ms: z.number(),
  error_name: z.string(),
  error_message: z.string(),
  status_code: z.number().optional(),
});
export type StepRetry = z.infer<typeof stepRetrySchema>;

export const stepTimingSchema = z.object({
  llm_first_token_ms: z.number().optional(),
  llm_stream_duration_ms: z.number().optional(),
});
export type StepTiming = z.infer<typeof stepTimingSchema>;

export const stepMessageSchema = z.object({
  type: z.literal('step'),
  ...timelineBaseFields,
  step_id: z.string(),
  turn_id: z.string(),
  ordinal: z.number(),
  state: z.enum(['running', 'completed', 'interrupted', 'failed']),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  usage: stepUsageSchema.optional(),
  finish_reason: z.string().optional(),
  timing: stepTimingSchema.optional(),
  retry: stepRetrySchema.optional(),
  end_reason: z.string().optional(),
  end_message: z.string().optional(),
});
export type StepMessage = z.infer<typeof stepMessageSchema>;
