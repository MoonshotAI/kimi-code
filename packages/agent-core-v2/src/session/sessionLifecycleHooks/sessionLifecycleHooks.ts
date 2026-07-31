/**
 * `sessionLifecycleHooks` domain (L1) — per-session lifecycle hook slots.
 *
 * Defines the `ISessionLifecycleHooks` seed: one ordered hook-slots instance
 * per session, created by the Workspace-scope `workspaceHandler` when it
 * materializes the session, seeded into the Session scope, and run by the
 * handler around the session's create (`onDidCreateSession`) and close
 * (`onWillCloseSession`). Session-scope consumers (e.g. `externalHooks`)
 * register against this session-domain contract and never see the Workspace
 * domain — the §3.5 seed-channel shape. Also owns the shared
 * `SessionCreateSource` / `SessionCloseReason` vocabulary both sides speak.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Hooks } from '#/hooks';

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit';

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
