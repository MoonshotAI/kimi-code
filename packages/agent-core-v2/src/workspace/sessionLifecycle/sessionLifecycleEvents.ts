/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

export interface SessionArchivedPayload {
  readonly sessionId: string;
  readonly workspaceId: string;
}

export class SessionArchived extends Event2<{ readonly payload: SessionArchivedPayload }> {
  static override readonly type = 'event.session.archived';
}
export interface SessionArchived {
  readonly payload: SessionArchivedPayload;
}

export interface SessionCreatedPayload {
  readonly agentId: string;
  readonly sessionId: string;
  readonly session: unknown;
}

export class SessionCreated extends Event2<{ readonly payload: SessionCreatedPayload }> {
  static override readonly type = 'event.session.created';
}
export interface SessionCreated {
  readonly payload: SessionCreatedPayload;
}
