import { z } from 'zod';

export const providerConfigResponseSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  api_key_env: z.string().optional(),
  has_api_key: z.boolean(),
});
export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const experimentalBucketSchema = z.record(z.string(), z.boolean());

export const experimentalConfigSchema = z
  .object({
    cli: experimentalBucketSchema.optional(),
    desktop: experimentalBucketSchema.optional(),
  })
  .strict();

const configFieldsSchema = z.object({
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  auto_session_title: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.unknown().optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.unknown().optional(),
  secondary_model: z.unknown().optional(),
  experimental: experimentalConfigSchema.optional(),
  telemetry: z.boolean().optional(),
  disable_feedback_survey: z.boolean().optional(),
});

export const configResponseSchema = configFieldsSchema
  .extend({
    providers: z.record(z.string(), providerConfigResponseSchema).default({}),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const patchConfigRequestSchema = configFieldsSchema.extend({
  providers: z.record(z.string(), z.unknown()).optional(),
});
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
