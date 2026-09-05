import { z } from 'zod';

export const userMessageOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), cron_id: z.string().min(1).optional(), schedule: z.string().min(1).optional() }),
  z.object({ kind: z.literal('channel'), channel_id: z.string().min(1) }),
  z.object({ kind: z.literal('task'), task_id: z.string().min(1) }),
  z.object({
    kind: z.literal('skill'),
    skill_name: z.string().min(1),
    args: z.string().optional(),
    trigger: z.string().optional(),
  }),
]);

export type UserMessageOrigin = z.infer<typeof userMessageOriginSchema>;
