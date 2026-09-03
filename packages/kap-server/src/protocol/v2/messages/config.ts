import { z } from 'zod';
import { globalBaseFields } from './base';

export const configMessageSchema = z.object({
  type: z.literal('config'),
  ...globalBaseFields,
  config: z.record(z.string(), z.unknown()),
  changed_fields: z.array(z.string()).optional(),
});
export type ConfigMessage = z.infer<typeof configMessageSchema>;

export const configWarningMessageSchema = z.object({
  type: z.literal('config.warning'),
  ...globalBaseFields,
  warnings: z.array(z.string()),
});
export type ConfigWarningMessage = z.infer<typeof configWarningMessageSchema>;

export const modelCatalogChangedMessageSchema = z.object({
  type: z.literal('model_catalog'),
  ...globalBaseFields,
});
export type ModelCatalogChangedMessage = z.infer<typeof modelCatalogChangedMessageSchema>;

export const pluginChangedMessageSchema = z.object({
  type: z.literal('plugin'),
  ...globalBaseFields,
});
export type PluginChangedMessage = z.infer<typeof pluginChangedMessageSchema>;

export const capabilityChangedMessageSchema = z.object({
  type: z.literal('capability'),
  ...globalBaseFields,
  capability_id: z.string().optional(),
});
export type CapabilityChangedMessage = z.infer<typeof capabilityChangedMessageSchema>;
