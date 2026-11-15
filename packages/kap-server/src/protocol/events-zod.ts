import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

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
  install: z.object({
    running: z.boolean(),
    step: z.string().optional(),
    percent: z.number().optional(),
    error: z.string().optional(),
    note: z.string().optional(),
    confirmationRequired: z.literal('stop-processes').optional(),
  }),
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

export const pushEventSchema = z.discriminatedUnion('type', [
  sessionGlobalEventSchema,
  workspaceGlobalEventSchema,
  configGlobalEventSchema,
  invalidatedGlobalEventSchema,
  capabilityGlobalEventSchema,
]);
