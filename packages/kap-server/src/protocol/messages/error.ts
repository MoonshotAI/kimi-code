import { z } from 'zod';

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.number().int(),
  msg: z.string(),
});

export type ErrorMessage = z.infer<typeof errorMessageSchema>;
