/**
 * `session` domain (L6) — session facade (post-god-object).
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
