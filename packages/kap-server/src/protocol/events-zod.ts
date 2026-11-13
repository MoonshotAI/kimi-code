import { z } from 'zod';

import { configResponseSchema } from './rest-config';
import { guiStoreEntrySchema } from './rest-guiStore';
import { sessionPendingInteractionSchema, sessionSchema } from './session';
import { workspaceSchema } from './workspace';

export const sessionMetaUpdatedEventSchema = z.object({
  type: z.literal('session.meta.updated'),
  title: z.string().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});

export const sessionCreatedEventSchema = z.object({
  type: z.literal('event.session.created'),
  session: sessionSchema,
});

export const sessionArchivedEventSchema = z.object({
  type: z.literal('event.session.archived'),
  workspace_id: z.string().min(1),
});

export const sessionRestoredEventSchema = z.object({
  type: z.literal('event.session.restored'),
  workspace_id: z.string().min(1),
});

export const sessionDeletedEventSchema = z.object({
  type: z.literal('event.session.deleted'),
  workspace_id: z.string().min(1),
});

export const workspaceCreatedEventSchema = z.object({
  type: z.literal('event.workspace.created'),
  workspace: workspaceSchema,
});

export const workspaceUpdatedEventSchema = z.object({
  type: z.literal('event.workspace.updated'),
  workspace: workspaceSchema,
});

export const workspaceDeletedEventSchema = z.object({
  type: z.literal('event.workspace.deleted'),
  workspace_id: z.string().min(1),
  root: z.string().min(1),
});

export const sessionWorkChangedEventSchema = z.object({
  type: z.literal('event.session.work_changed'),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

export const environmentStatusSchema = z.enum([
  'pending',
  'connecting',
  'ready',
  'disconnected',
  'disposed',
]);

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string().min(1)),
  config: configResponseSchema,
});

export const configWarningEventSchema = z.object({
  type: z.literal('event.config.warning'),
  warnings: z.array(
    z.object({
      domain: z.string().optional(),
      message: z.string(),
    }),
  ),
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

export const pluginChangedEventSchema = z.object({
  type: z.literal('event.plugin.changed'),
});

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

export const guiStoreUpdatedEventSchema = z.object({
  type: z.literal('event.gui_store.updated'),
  revision: z.number().int().min(1),
  entries: z.record(z.string(), guiStoreEntrySchema.nullable()),
});

export const pushEventSchema = z.discriminatedUnion('type', [
  sessionMetaUpdatedEventSchema,
  sessionCreatedEventSchema,
  sessionArchivedEventSchema,
  sessionRestoredEventSchema,
  sessionDeletedEventSchema,
  workspaceCreatedEventSchema,
  workspaceUpdatedEventSchema,
  workspaceDeletedEventSchema,
  sessionWorkChangedEventSchema,
  configChangedEventSchema,
  configWarningEventSchema,
  modelCatalogChangedEventSchema,
  pluginChangedEventSchema,
  capabilityChangedEventSchema,
  guiStoreUpdatedEventSchema,
]).and(
  z.object({
    agentId: z.string(),
    sessionId: z.string(),
  }),
);
