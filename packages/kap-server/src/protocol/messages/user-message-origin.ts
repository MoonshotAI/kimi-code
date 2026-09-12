import { z } from 'zod';

export const userMessageOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    cron_id: z.string().min(1).optional(),
    schedule: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    cron_id: z.string().min(1).optional(),
    schedule: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('task'),
    task_id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    severity: z.string().optional(),
    type: z.string().optional(),
    source_kind: z.string().optional(),
    source_id: z.string().optional(),
    agent_id: z.string().optional(),
    raw: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('skill'),
    skill_name: z.string().min(1),
    args: z.string().optional(),
    trigger: z.string().optional(),
  }),
]);

export type UserMessageOrigin = z.infer<typeof userMessageOriginSchema>;

export type TaskNotificationPayload = Omit<Extract<UserMessageOrigin, { kind: 'task' }>, 'kind' | 'task_id'>;
