/**
 * `sessionActivity` domain (L6) — session-level activity and status.
 *
 * Defines the public contract of session activity: the `SessionStatus` model
 * and the `ISessionActivity` used to query the session's derived lifecycle
 * phase (`status`) and whether it is idle (`isIdle`). Session-scoped — one
 * instance per session. The status is derived from the session's pending
 * interactions and each agent's active turn; it owns no state.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export interface ISessionActivity {
  readonly _serviceBrand: undefined;

  status(): SessionStatus;
  isIdle(): boolean;
}

export const ISessionActivity: ServiceIdentifier<ISessionActivity> =
  createDecorator<ISessionActivity>('sessionActivity');
