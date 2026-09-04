import { z } from 'zod';

import { globalMessageBase } from './base';

export const configWarningMessageSchema = z.object({
  type: z.literal('config.warning'),
  ...globalMessageBase,
  warnings: z.array(z.string()),
});

export type ConfigWarning = z.infer<typeof configWarningMessageSchema>;
