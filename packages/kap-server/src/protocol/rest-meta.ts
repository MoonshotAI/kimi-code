import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { fsOpenInAppIdSchema } from './rest-fs';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  feedback: z.literal(true).optional(),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  tasks: z.literal(true),
  interactions_list: z.literal(true),
  session_wait: z.literal(true),
  agent_close: z.literal(true),
  session_continue: z.literal(true),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaFeatureStateSchema = z.enum([
  'Pending',
  'Activating',
  'Active',
  'Unloading',
  'Failed',
]);

export const metaFeatureSchema = z.object({
  name: z.string().min(1),
  state: metaFeatureStateSchema,
  meta: z.record(z.string(), z.unknown()),
});

export type MetaFeature = z.infer<typeof metaFeatureSchema>;

export const metaExperimentalBetaSchema = z.object({
  profile: z.enum(['cli', 'desktop']),
  enabled: z.boolean(),
  source: z.enum(['env', 'config', 'default']),
  env: z.string().min(1),
  config_value: z.boolean().optional(),
});

export type MetaExperimentalBeta = z.infer<typeof metaExperimentalBetaSchema>;

export const metaExperimentalFeatureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  stage: z.enum(['experimental', 'beta', 'ga']),
  effect_timing: z.enum(['immediate', 'next-session', 'restart']),
  env: z.string().min(1),
  enabled: z.boolean(),
  active: z.boolean(),
  source: z.enum(['env', 'master-env', 'beta-config', 'config', 'default']),
  config_value: z.boolean().optional(),
});

export type MetaExperimentalFeature = z.infer<typeof metaExperimentalFeatureSchema>;

export const metaResponseSchema = z.object({
  kimi_agent_protocol_version: z.string().min(1),
  server_version: z.string().min(1),
  product: z.string().min(1).optional(),
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  started_at: isoDateTimeSchema,
  home_dir: z.string().min(1),
  open_in_apps: z.array(fsOpenInAppIdSchema),
  dangerous_bypass_auth: z.boolean(),
  experimental_flags: z.record(z.string(), z.boolean()).optional(),
  experimental_beta: metaExperimentalBetaSchema.optional(),
  experimental_features: z.array(metaExperimentalFeatureSchema).optional(),
  web_title: z.string().optional(),
  features: z.array(metaFeatureSchema).optional(),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
