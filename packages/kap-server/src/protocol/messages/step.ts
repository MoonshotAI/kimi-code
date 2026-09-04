import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';
import { stepUsageSchema } from './step-usage';

export const stepTimingSchema = z.object({
  llm_first_token_ms: z.number().nonnegative().optional(),
  llm_stream_duration_ms: z.number().nonnegative().optional(),
});

export type StepTiming = z.infer<typeof stepTimingSchema>;

export const stepRetrySchema = z.object({
  failed_attempt: z.number().int().positive(),
  next_attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  delay_ms: z.number().nonnegative(),
  error_name: z.string(),
  error_message: z.string(),
  status_code: z.number().int().optional(),
});

export type StepRetry = z.infer<typeof stepRetrySchema>;

export const stepMessageSchema = z.object({
  type: z.literal('step'),
  ...timelineMessageBase,
  step_id: z.string().min(1),
  turn_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  state: z.enum(['running', 'completed', 'interrupted', 'failed']),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  usage: stepUsageSchema.optional(),
  finish_reason: z.string().optional(),
  timing: stepTimingSchema.optional(),
  retry: stepRetrySchema.optional(),
  end_reason: z.string().optional(),
  end_message: z.string().optional(),
});

export type StepMessage = z.infer<typeof stepMessageSchema>;
