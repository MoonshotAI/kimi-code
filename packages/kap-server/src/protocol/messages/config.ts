import { z } from 'zod';

import { globalMessageBase } from './base';

export const configMessageSchema = z.object({
  type: z.literal('config'),
  ...globalMessageBase,
  config: z.unknown().nonoptional(),
  changed_fields: z.array(z.string().min(1)).optional(),
});

export type ConfigMessage = z.infer<typeof configMessageSchema>;
