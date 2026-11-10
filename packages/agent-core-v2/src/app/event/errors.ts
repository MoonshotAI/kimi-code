import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const EventErrors = {
  codes: {
    EVENT_DUPLICATE_EVENT: 'event.duplicate_event',
    EVENT_SCHEMA_MISSING: 'event.schema_missing',
  },
  info: {
    'event.duplicate_event': {
      title: 'Duplicate event type',
      retryable: false,
      public: true,
      action:
        'Two event classes registered the same type; rename one. This is a build-time bug.',
    },
    'event.schema_missing': {
      title: 'Durable event without schema',
      retryable: false,
      public: true,
      action: 'A durable event class must declare a zod payload schema for replay.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(EventErrors);

export type EventErrorCode = (typeof EventErrors.codes)[keyof typeof EventErrors.codes];

export class EventError extends Error2 {
  constructor(code: EventErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'EventError';
  }
}
