/**
 * `sessionToolPolicy` domain (L3) — session-wide client tool restrictions.
 *
 * Defines the Session-scoped policy shared by every Agent in a session. The
 * client-managed denylist is persisted independently from each Agent's frozen
 * profile policy, survives resume, and emits an awaitable change event so
 * existing agents can refresh policy-derived system-prompt content before the
 * mutating request continues.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';

export type SessionToolPolicyChangedEvent = IWaitUntil;

export interface ISessionToolPolicy {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<SessionToolPolicyChangedEvent>;

  disabledTools(): readonly string[];
  setDisabledTools(names: readonly string[]): Promise<void>;
}

export const ISessionToolPolicy: ServiceIdentifier<ISessionToolPolicy> =
  createDecorator<ISessionToolPolicy>('sessionToolPolicy');
