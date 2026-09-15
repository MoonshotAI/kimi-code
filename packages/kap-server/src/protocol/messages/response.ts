import { z } from 'zod';

export const responseMessageSchema = z.object({
  type: z.literal('response'),
  request_id: z.string().min(1),
  code: z.number().int(),
  msg: z.string().optional(),
});

export type ResponseMessage = z.infer<typeof responseMessageSchema>;
