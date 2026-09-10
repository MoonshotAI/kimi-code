import { z } from 'zod';

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: z.number().int().nonnegative(),
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).optional(),
  omit: z.array(z.string().min(1)).optional(),
});

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
