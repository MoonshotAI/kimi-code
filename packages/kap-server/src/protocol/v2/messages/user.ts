import { z } from 'zod';
import { timelineBaseFields } from './base';

export const userMessageOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), cron_id: z.string(), schedule: z.string() }),
  z.object({ kind: z.literal('channel'), channel_id: z.string() }),
  z.object({ kind: z.literal('task'), task_id: z.string() }),
  z.object({
    kind: z.literal('skill'),
    skill_name: z.string(),
    args: z.string().optional(),
    trigger: z.string().optional(),
  }),
]);
export type UserMessageOrigin = z.infer<typeof userMessageOriginSchema>;

export const taskNotificationPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  severity: z.string().optional(),
  type: z.string().optional(),
  source_kind: z.string().optional(),
  source_id: z.string().optional(),
  agent_id: z.string().optional(),
  raw: z.string().optional(),
});
export type TaskNotificationPayload = z.infer<typeof taskNotificationPayloadSchema>;

export const skillActivationSchema = z.object({
  skill_name: z.string(),
  skill_args: z.string().optional(),
});
export type SkillActivation = z.infer<typeof skillActivationSchema>;

export const userMessageSchema = z.object({
  type: z.literal('user'),
  ...timelineBaseFields,
  message_id: z.string(),
  turn_id: z.string(),
  step_id: z.string().optional(),
  text: z.string(),
  attachment_ids: z.array(z.string()).optional(),
  skill_activations: z.array(skillActivationSchema).optional(),
  status: z.enum(['running', 'completed']),
  created_at: z.string(),
  finished_at: z.string().optional(),
  steered_at: z.string().optional(),
  origin: userMessageOriginSchema.optional(),
  notification: taskNotificationPayloadSchema.optional(),
});
export type UserMessage = z.infer<typeof userMessageSchema>;
