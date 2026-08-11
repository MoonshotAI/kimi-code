/**
 * `sessionLifecycleHooks` domain — per-session lifecycle hook slots.
 *
 * Defines the `ISessionLifecycleHooks` seed: one ordered hook-slots instance
 * per session, with slots around the session's create (`onDidCreateSession`)
 * and close (`onWillCloseSession`). Also owns the shared
 * `SessionCreateSource` / `SessionCloseReason` vocabulary.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Hooks } from '#/hooks';

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit' | 'archive';

export interface SessionStartHookEvent {
  readonly source: SessionCreateSource;
}

export interface SessionEndHookEvent {
  readonly reason: SessionCloseReason;
}

export type SessionLifecycleHookSlots = {
  readonly onDidCreateSession: SessionStartHookEvent;
  readonly onWillCloseSession: SessionEndHookEvent;
};

export const ISessionLifecycleHooks: ServiceIdentifier<Hooks<SessionLifecycleHookSlots>> =
  createDecorator<Hooks<SessionLifecycleHookSlots>>('sessionLifecycleHooks');

export function sessionLifecycleHooksSeed(hooks: Hooks<SessionLifecycleHookSlots>): ScopeSeed {
  return [[ISessionLifecycleHooks as ServiceIdentifier<unknown>, hooks]];
}
