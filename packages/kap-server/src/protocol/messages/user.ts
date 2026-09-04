import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';
import { userMessageOriginSchema } from './user-message-origin';

export const skillActivationSchema = z.object({
  skill_name: z.string().min(1),
  skill_args: z.string().optional(),
});

export type SkillActivation = z.infer<typeof skillActivationSchema>;

export const userMessageSchema = z.object({
  type: z.literal('user'),
  ...timelineMessageBase,
  message_id: z.string().min(1),
  turn_id: z.string().min(1),
  step_id: z.string().min(1).optional(),
  text: z.string(),
  attachment_ids: z.array(z.string().min(1)).optional(),
  skill_activations: z.array(skillActivationSchema).optional(),
  status: z.enum(['running', 'completed']),
  created_at: isoDateTimeSchema,
  finished_at: isoDateTimeSchema.optional(),
  steered_at: isoDateTimeSchema.optional(),
  origin: userMessageOriginSchema.optional(),
});

export type UserMessage = z.infer<typeof userMessageSchema>;
