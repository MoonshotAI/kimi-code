/**
 * Klient-level session-scope events — the public, typed, namespaced event
 * surface of one session. Mirrors the pattern of `../global/events.ts`;
 * stream names match the kap-server session event map (`interactions`,
 * `interactions:resolved`).
 */

import { z } from 'zod';

import type {
  Interaction,
  InteractionResolution,
} from '@moonshot-ai/agent-core-v2/human/interaction/interaction';
import type { SessionMetadataChangedEvent } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

import type { EventRegistration } from '../types.js';
import {
  interactionResolutionSchema,
  interactionSchema,
} from './interaction.js';
import { sessionMetadataChangedEventSchema } from './metadata.js';

/**
 * Scope-stream registration (`kind: 'stream'`). Declared structurally here
 * until `EventRegistration` in `../types.js` gains the `stream` variant;
 * compatible with `src/core/events/hub.ts`, which already switches on it.
 */
interface StreamEventRegistration {
  readonly kind: 'stream';
  readonly name: string;
  readonly type?: string;
  readonly schema: z.ZodType;
}

type SessionEventRegistration = EventRegistration | StreamEventRegistration;

/** Public event name → payload type. Keys must stay in sync with `sessionEvents`. */
export interface SessionEventPayloads {
  'metadata.changed': SessionMetadataChangedEvent;
  'interactions.changed': readonly Interaction[];
  'interactions.resolved': InteractionResolution;
  /** The merged skill catalog changed; the payload is the changed source id. */
  'skills.changed': string;
  'artex.exploration.updated': Record<string, unknown>;
  'artex.finding.reported': Record<string, unknown>;
  'artex.activity.appended': Record<string, unknown>;
  'artex.traffic.captured': Record<string, unknown>;
}

export type SessionEventName = keyof SessionEventPayloads;

/** Public event name → source binding + payload schema. */
export const sessionEvents = {
  'metadata.changed': {
    kind: 'emitter',
    service: 'sessionMetadata',
    event: 'onDidChangeMetadata',
    schema: sessionMetadataChangedEventSchema,
  },
  'skills.changed': {
    kind: 'emitter',
    service: 'sessionSkillCatalog',
    event: 'onDidChange',
    schema: z.string(),
  },
  // Passthrough stream (no `type` filter): the source pushes the full
  // pending interaction set on every change.
  'interactions.changed': {
    kind: 'stream',
    name: 'interactions',
    schema: z.array(interactionSchema),
  },
  'interactions.resolved': {
    kind: 'stream',
    name: 'interactions:resolved',
    schema: interactionResolutionSchema,
  },
  'artex.exploration.updated': {
    kind: 'stream',
    name: 'artex:events',
    type: 'artex.exploration.updated',
    schema: z.looseObject({ type: z.literal('artex.exploration.updated') }),
  },
  'artex.finding.reported': {
    kind: 'stream',
    name: 'artex:events',
    type: 'artex.finding.reported',
    schema: z.looseObject({ type: z.literal('artex.finding.reported') }),
  },
  'artex.activity.appended': {
    kind: 'stream',
    name: 'artex:events',
    type: 'artex.activity.appended',
    schema: z.looseObject({ type: z.literal('artex.activity.appended') }),
  },
  'artex.traffic.captured': {
    kind: 'stream',
    name: 'artex:events',
    type: 'artex.traffic.captured',
    schema: z.looseObject({ type: z.literal('artex.traffic.captured') }),
  },
} satisfies Record<SessionEventName, SessionEventRegistration>;
