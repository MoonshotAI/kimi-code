import { z } from 'zod';

import { epochMsSchema } from './base';
import { userMessageOriginSchema } from './user-message-origin';

export const contentPartSchema = z.object({
  type: z.enum(['text', 'think', 'image', 'audio', 'video']),
  text: z.string(),
  meta: z.record(z.string(), z.any()),
});

export type ContentPart = z.infer<typeof contentPartSchema>;

export const skillActivationSchema = z.object({
  skill_name: z.string().min(1),
  skill_args: z.string().optional(),
});

export type SkillActivation = z.infer<typeof skillActivationSchema>;

export const userMessageSchema = z.object({
  type: z.literal('user'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  message_id: z.string().min(1),
  turn_id: z.string().min(1).optional(),
  status: z.enum(['unread', 'read']),
  timestamp: epochMsSchema.optional(),
  text: z.array(contentPartSchema),
  attachment_ids: z.array(z.string().min(1)).optional(),
  skill_activations: z.array(skillActivationSchema).optional(),
  origin: userMessageOriginSchema.optional(),
});

export type UserMessage = z.infer<typeof userMessageSchema>;
