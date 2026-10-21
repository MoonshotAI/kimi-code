import { z } from 'zod';

import type { ConfigChangedEvent } from '@moonshot-ai/agent-core-v2/app/config/config';
import type { ModelsChangedEvent } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import type { ProvidersChangedEvent } from '@moonshot-ai/agent-core-v2/llm-adapter/provider/provider';
import type { ReloadSummary } from '@moonshot-ai/agent-core-v2/app/plugin/types';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';

import { stringDeltaSchema } from '../helpers.js';
import type { EventRegistration } from '../types.js';

export interface SessionArchivedPayload {
  readonly sessionId: string;
}

export interface SessionMetaUpdatedPayload {
  readonly agentId: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly patch: {
    readonly title?: string;
    readonly isCustomTitle?: boolean;
    readonly lastPrompt?: string;
  };
}

export type CatalogChangedPayload = Awaited<
  ReturnType<IProviderDiscoveryService['refreshProviderModels']>
>;

export interface KlientEventPayloads {
  'config.changed': ConfigChangedEvent;
  'config.sectionChanged': ConfigChangedEvent;
  'kosong.providers.changed': ProvidersChangedEvent;
  'kosong.models.changed': ModelsChangedEvent;
  'plugins.reloaded': ReloadSummary;
  'session.archived': SessionArchivedPayload;
  'session.metaUpdated': SessionMetaUpdatedPayload;
  'kosong.changed': CatalogChangedPayload;
}

export type KlientEventName = keyof KlientEventPayloads;

const configChangedSchema = z.object({
  domain: z.string(),
  source: z.enum(['load', 'reload', 'set']),
  value: z.unknown(),
  previousValue: z.unknown(),
});

const reloadSummarySchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), message: z.string() })),
});

const sessionMetaUpdatedSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  title: z.string().optional(),
  patch: z.object({
    title: z.string().optional(),
    isCustomTitle: z.boolean().optional(),
    lastPrompt: z.string().optional(),
  }),
}) satisfies z.ZodType<SessionMetaUpdatedPayload>;

export const catalogChangedSchema = z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
  retired_default: z
    .object({
      from: z.string(),
      to: z.string(),
      from_display_name: z.string(),
    })
    .optional(),
});

export const globalEvents = {
  'config.changed': {
    kind: 'emitter',
    service: 'configService',
    event: 'onDidChangeConfiguration',
    schema: configChangedSchema,
  },
  'config.sectionChanged': {
    kind: 'emitter',
    service: 'configService',
    event: 'onDidSectionChange',
    schema: configChangedSchema,
  },
  'kosong.providers.changed': {
    kind: 'emitter',
    service: 'providerService',
    event: 'onDidChangeProviders',
    schema: stringDeltaSchema,
  },
  'kosong.models.changed': {
    kind: 'emitter',
    service: 'modelService',
    event: 'onDidChangeModels',
    schema: stringDeltaSchema,
  },
  'plugins.reloaded': {
    kind: 'emitter',
    service: 'pluginService',
    event: 'onDidReload',
    schema: reloadSummarySchema,
  },
  'session.archived': {
    kind: 'bus',
    type: 'event.session.archived',
    schema: z.object({ sessionId: z.string() }),
  },
  'session.metaUpdated': {
    kind: 'bus',
    type: 'session.meta.updated',
    schema: sessionMetaUpdatedSchema,
  },
  'kosong.changed': {
    kind: 'bus',
    type: 'event.model_catalog.changed',
    schema: catalogChangedSchema,
  },
} satisfies Record<KlientEventName, EventRegistration>;
