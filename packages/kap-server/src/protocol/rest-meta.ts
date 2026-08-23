import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { fsOpenInAppIdSchema } from './rest-fs';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  tasks: z.literal(true),
  terminal: z.literal(true),
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

export const metaResponseSchema = z.object({
  server_version: z.string().min(1),
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  started_at: isoDateTimeSchema,
  open_in_apps: z.array(fsOpenInAppIdSchema),
  dangerous_bypass_auth: z.boolean(),
  experimental_flags: z.record(z.string(), z.boolean()).optional(),
  backend: z.enum(['v1', 'v2']).optional(),
  web_title: z.string().optional(),
  features: z.array(metaFeatureSchema).optional(),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
