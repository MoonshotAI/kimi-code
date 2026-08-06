/**
 * `sessionActivity` domain — `ISessionOutcomeMirror` contract: persist the
 * latest main-turn outcome into durable session metadata.
 *
 * The activity aggregate's `lastTurnReason` is live fold state, rebuilt per
 * process; this mirror is the write side that lands terminal outcomes in
 * the session's metadata document, so the session index (and therefore cold
 * listings after a restart) keep reporting them. Session-scoped — one
 * instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionOutcomeMirror {
  readonly _serviceBrand: undefined;
}

export const ISessionOutcomeMirror: ServiceIdentifier<ISessionOutcomeMirror> =
  createDecorator<ISessionOutcomeMirror>('sessionOutcomeMirror');
