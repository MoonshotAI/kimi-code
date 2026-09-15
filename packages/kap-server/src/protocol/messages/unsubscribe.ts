import { z } from 'zod';

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  request_id: z.string().min(1),
  session_id: z.string().min(1),
});

export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;
