import { z } from 'zod';

export const ackMessageSchema = z.object({
  type: z.literal('ack'),
  id: z.number().int().nonnegative(),
  code: z.number().int(),
  msg: z.string().optional(),
});

export type AckMessage = z.infer<typeof ackMessageSchema>;
