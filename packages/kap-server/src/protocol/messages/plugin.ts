import { z } from 'zod';

import { globalMessageBase } from './base';

export const pluginMessageSchema = z.object({
  type: z.literal('plugin'),
  ...globalMessageBase,
});

export type PluginChanged = z.infer<typeof pluginMessageSchema>;

export type PluginChangedMessage = PluginChanged;
