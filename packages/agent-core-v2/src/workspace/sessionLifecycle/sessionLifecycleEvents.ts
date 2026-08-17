/**
 * `sessionLifecycle` domain — the App-scope session lifecycle `Event2`
 * classes broadcast on `IEventService`.
 *
 * `SessionArchived` is published by this domain's lifecycle service after a
 * session's metadata carries the archived flag and its agents are drained.
 * `SessionCreated` is published by the server edge (kap-server) after a
 * create / fork / createChild route answers, carrying the wire session
 * document the edge just returned — core never owns that document's shape,
 * so `session` stays opaque here. Never persisted; consumers read the
 * `payload` bag. Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { Event2 } from '#/app/event/event2';

export interface SessionArchivedPayload {
  readonly sessionId: string;
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
