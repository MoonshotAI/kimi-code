import { z } from 'zod';

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol_version: z.string().min(1),
  server_id: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
});

export type HelloMessage = z.infer<typeof helloMessageSchema>;
