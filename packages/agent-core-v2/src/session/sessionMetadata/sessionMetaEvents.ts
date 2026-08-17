/**
 * `sessionMetadata` domain — the App-scope `session.meta.updated` event.
 *
 * Observable App-level fact broadcast after the session metadata document
 * changes (title, lastPrompt, …); consumers read the `payload` patch bag.
 * Never persisted. Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { Event2 } from '#/app/event/event2';

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

export class SessionMetaUpdated extends Event2<{ readonly payload: SessionMetaUpdatedPayload }> {
  static override readonly type = 'session.meta.updated';
}
export interface SessionMetaUpdated {
  readonly payload: SessionMetaUpdatedPayload;
}
