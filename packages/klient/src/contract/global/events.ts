/**
 * Klient-level global events — the public, typed, namespaced event surface.
 * Each registration binds a public event name to its underlying source (the
 * `IEventService` bus or one service's `onDid*` emitter) plus the zod schema
 * its payload must satisfy. Consumers never see the engine's `onDid`/`onWill`
 * naming; unknown bus event types are not forwarded.
 */

import { z } from 'zod';

import type { ConfigChangedEvent } from '@moonshot-ai/agent-core-v2/app/config/config';
import type { ModelsChangedEvent } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { ProvidersChangedEvent } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type { ReloadSummary } from '@moonshot-ai/agent-core-v2/app/plugin/types';
import type { IOAuthService } from '@moonshot-ai/agent-core-v2/app/auth/auth';

import { stringDeltaSchema } from '../helpers.js';
import type { EventRegistration } from '../types.js';

/** Payload of `event.session.archived` on the global bus. */
export interface SessionArchivedPayload {
  readonly sessionId: string;
}

/** Payload of `session.meta.updated` on the global bus (`agent/rpc/prompt-metadata.ts`). */
export interface SessionMetaUpdatedPayload {
  readonly agentId: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly patch: {
    readonly title?: string;
    readonly isCustomTitle?: boolean;
    readonly lastPrompt: string;
  };
}

/** Payload of `event.model_catalog.changed` — same shape as an OAuth refresh result. */
export type CatalogChangedPayload = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;

/** Public event name → payload type. Keys must stay in sync with `globalEvents`. */
export interface KlientEventPayloads {
  'config.changed': ConfigChangedEvent;
  'config.sectionChanged': ConfigChangedEvent;
  'providers.changed': ProvidersChangedEvent;
  'models.changed': ModelsChangedEvent;
  'plugins.reloaded': ReloadSummary;
  'session.archived': SessionArchivedPayload;
  'session.metaUpdated': SessionMetaUpdatedPayload;
  'catalog.changed': CatalogChangedPayload;
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
    lastPrompt: z.string(),
  }),
});

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
});

/** Public event name → source binding + payload schema. */
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
  'providers.changed': {
    kind: 'emitter',
    service: 'providerService',
    event: 'onDidChangeProviders',
    schema: stringDeltaSchema,
  },
  'models.changed': {
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
  'catalog.changed': {
    kind: 'bus',
    type: 'event.model_catalog.changed',
    schema: catalogChangedSchema,
  },
} satisfies Record<KlientEventName, EventRegistration>;
