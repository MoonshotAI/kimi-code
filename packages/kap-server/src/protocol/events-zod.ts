import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { capabilityInstallProgressSchema } from './rest-capability';
import { configResponseSchema } from './rest-config';
import { sessionSchema } from './session';
import { workspaceSchema } from './workspace';

const eventCreatedAt = { event_created_at: isoDateTimeSchema };

export const sessionGlobalEventSchema = z.object({
  type: z.literal('session'),
  change: z.enum(['created', 'updated', 'archived', 'restored', 'deleted']),
  session: sessionSchema,
  ...eventCreatedAt,
});

export const workspaceGlobalEventSchema = z.object({
  type: z.literal('workspace'),
  change: z.enum(['created', 'updated', 'deleted']),
  workspace: workspaceSchema,
  ...eventCreatedAt,
});

export const configWarningSchema = z.object({
  domain: z.string().optional(),
  message: z.string(),
});

export const configGlobalEventSchema = z.object({
  type: z.literal('config'),
  config: configResponseSchema,
  warnings: z.array(configWarningSchema).optional(),
  ...eventCreatedAt,
});

export const invalidatedGlobalEventSchema = z.object({
  type: z.literal('invalidated'),
  kind: z.enum(['models', 'plugins']),
  ...eventCreatedAt,
});

export const environmentStatusSchema = z.enum([
  'pending',
  'connecting',
  'ready',
  'disconnected',
  'disposed',
]);

export const capabilityChangedEventSchema = z.object({
  type: z.literal('event.capability.changed'),
  capability_id: z.string(),
  install: capabilityInstallProgressSchema,
});

export const capabilityGlobalEventSchema = capabilityChangedEventSchema.extend(eventCreatedAt);

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string().min(1)),
  config: configResponseSchema,
});

export const modelCatalogChangedEventSchema = z.object({
  type: z.literal('event.model_catalog.changed'),
  changed: z.array(
    z.object({
      provider_id: z.string().min(1),
      provider_name: z.string().min(1),
      added: z.number().int().min(0),
      removed: z.number().int().min(0),
    }),
  ),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(
    z.object({
      provider: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  retired_default: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      from_display_name: z.string().min(1),
    })
    .optional(),
});

export const hostSnapshotSchema = z.object({
  id: z.string(),
  host: z.string(),
  identity_file: z.string().optional(),
  remote_bin: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  status: z.enum(['pending', 'connecting', 'ready', 'disconnected']),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;

export const hostChangedEventSchema = z.object({
  type: z.literal('event.host.changed'),
  hosts: z.array(hostSnapshotSchema),
});

export const hostGlobalEventSchema = hostChangedEventSchema.extend(eventCreatedAt);

export const pushEventSchema = z.discriminatedUnion('type', [
  sessionGlobalEventSchema,
  workspaceGlobalEventSchema,
  configGlobalEventSchema,
  invalidatedGlobalEventSchema,
  capabilityGlobalEventSchema,
  hostGlobalEventSchema,
]);
