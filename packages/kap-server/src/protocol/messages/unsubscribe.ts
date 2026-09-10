import { z } from 'zod';

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: z.number().int().nonnegative(),
  session_id: z.string().min(1),
});

export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;
