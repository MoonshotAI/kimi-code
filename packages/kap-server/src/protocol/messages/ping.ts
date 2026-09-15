import { z } from 'zod';

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
  request_id: z.string().min(1),
});

export type PingMessage = z.infer<typeof pingMessageSchema>;
