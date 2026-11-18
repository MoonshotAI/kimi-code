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

interface StreamEventRegistration {
  readonly kind: 'stream';
  readonly name: string;
  readonly type?: string;
  readonly schema: z.ZodType;
}

type SessionEventRegistration = EventRegistration | StreamEventRegistration;

export interface SessionEventPayloads {
  'metadata.changed': SessionMetadataChangedEvent;
  'interactions.changed': readonly Interaction[];
  'interactions.resolved': InteractionResolution;
  'skills.changed': string;
}

export type SessionEventName = keyof SessionEventPayloads;

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
} satisfies Record<SessionEventName, SessionEventRegistration>;
