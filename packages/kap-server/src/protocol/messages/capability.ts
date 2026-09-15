import { z } from 'zod';

import { globalMessageBase } from './base';

export const capabilityMessageSchema = z.object({
  type: z.literal('capability'),
  ...globalMessageBase,
  capability_id: z.string().min(1).optional(),
});

export type CapabilityChanged = z.infer<typeof capabilityMessageSchema>;

export type CapabilityChangedMessage = CapabilityChanged;
