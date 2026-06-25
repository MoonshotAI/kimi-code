/**
 * `session` domain (L6) — session facade.
 *
 * Defines the public contract of a session: the `SessionStatus` model and the
 * `ISessionService` used by upper layers to query status, manage child agents
 * (`fork` / `listChildren`), and run session operations (`compact` / `undo` /
 * `archive`). Session-scoped — one instance per session. The agent loop itself
 * is driven by `agent-lifecycle` and `turn`, not here.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';

export type SessionStatus = 'running' | 'idle' | 'awaiting_approval';

export interface ISessionService {
  readonly _serviceBrand: undefined;
  status(): SessionStatus;
  agents(): readonly IScopeHandle[];
  fork(): Promise<IScopeHandle>;
  listChildren(): readonly IScopeHandle[];
  compact(): Promise<void>;
  undo(): Promise<void>;
  archive(): Promise<void>;
}

export const ISessionService: ServiceIdentifier<ISessionService> =
  createDecorator<ISessionService>('sessionService');
