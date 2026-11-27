import { UI_PREFERENCE_KEY_PATTERN } from '@moonshot-ai/kimi-code-product/ui-preferences';
import { z } from 'zod';

const MAX_OPS_PER_PATCH = 200;
const MAX_FIELD_LENGTH = 512;

export const uiPreferenceKeySchema = z
  .string()
  .max(128)
  .regex(UI_PREFERENCE_KEY_PATTERN, 'key must be dotted snake_case, e.g. sidebar.pinned_sessions');

const uiPreferenceFieldSchema = z.string().min(1).max(MAX_FIELD_LENGTH);

const jsonValueSchema = z.unknown().refine((value) => value !== undefined, 'value is required');

export const uiPreferenceOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), key: uiPreferenceKeySchema, value: jsonValueSchema }),
  z.object({ op: z.literal('unset'), key: uiPreferenceKeySchema }),
  z.object({ op: z.literal('add'), key: uiPreferenceKeySchema, value: jsonValueSchema }),
  z.object({ op: z.literal('remove'), key: uiPreferenceKeySchema, value: jsonValueSchema }),
  z.object({
    op: z.literal('set_field'),
    key: uiPreferenceKeySchema,
    field: uiPreferenceFieldSchema,
    value: jsonValueSchema,
  }),
  z.object({ op: z.literal('unset_field'), key: uiPreferenceKeySchema, field: uiPreferenceFieldSchema }),
]);
export type UiPreferenceOp = z.infer<typeof uiPreferenceOpSchema>;

const uiPreferenceValuesSchema = z.record(uiPreferenceKeySchema, z.unknown());

export const getUiPreferencesResponseSchema = z.object({
  revision: z.number().int().min(0),
  values: uiPreferenceValuesSchema,
});
export type GetUiPreferencesResponse = z.infer<typeof getUiPreferencesResponseSchema>;

export const patchUiPreferencesRequestSchema = z.object({
  ops: z.array(uiPreferenceOpSchema).min(1).max(MAX_OPS_PER_PATCH),
  client_id: z.string().min(1).max(128).optional(),
});
export type PatchUiPreferencesRequest = z.infer<typeof patchUiPreferencesRequestSchema>;

export const uiPreferencesChangedSchema = z.record(uiPreferenceKeySchema, z.unknown());

export const patchUiPreferencesResponseSchema = z.object({
  revision: z.number().int().min(0),
  changed: uiPreferencesChangedSchema,
});
export type PatchUiPreferencesResponse = z.infer<typeof patchUiPreferencesResponseSchema>;

export const importUiPreferencesRequestSchema = z.object({
  values: uiPreferenceValuesSchema,
  client_id: z.string().min(1).max(128).optional(),
});
export type ImportUiPreferencesRequest = z.infer<typeof importUiPreferencesRequestSchema>;

export const importUiPreferencesResponseSchema = z.object({
  revision: z.number().int().min(0),
  imported: z.array(z.string()),
  skipped: z.array(z.string()),
});
export type ImportUiPreferencesResponse = z.infer<typeof importUiPreferencesResponseSchema>;

export const uiPreferencesActionParamSchema = z.object({
  action: z.string().min(1),
});
