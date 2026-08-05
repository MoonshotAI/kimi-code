/**
 * `sessionActivity` domain — `ISessionOutcomeRecorder` contract: persist the
 * latest main-turn outcome into durable session metadata.
 *
 * The activity aggregate's `lastTurnReason` is live fold state, rebuilt per
 * process; this recorder is the write side that lands it in the session's
 * metadata document, so the session index (and therefore cold listings after
 * a restart) keep reporting the outcome. Session-scoped — one instance per
 * session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionOutcomeRecorder {
  readonly _serviceBrand: undefined;
}

export const ISessionOutcomeRecorder: ServiceIdentifier<ISessionOutcomeRecorder> =
  createDecorator<ISessionOutcomeRecorder>('sessionOutcomeRecorder');
