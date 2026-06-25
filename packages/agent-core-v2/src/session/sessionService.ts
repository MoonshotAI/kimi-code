/**
 * `session` domain (L6) — `ISessionService` implementation.
 *
 * Owns the session's child-agent set and session-level operations; drives
 * agent lifecycle through `agent-lifecycle`, broadcasts through `event`,
 * persists session metadata through `records`, and records activity through
 * `session-activity`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event/event';
import { ISessionMetaStore } from '#/records/records';
import { ISessionActivity } from '#/session-activity/sessionActivity';

import { type SessionStatus, ISessionService } from './session';

export class SessionService implements ISessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionMetaStore _meta: ISessionMetaStore,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionActivity private readonly activity: ISessionActivity,
    @IEventService _event: IEventService,
  ) {}

  status(): SessionStatus {
    return this.activity.isIdle() ? 'idle' : 'running';
  }

  agents(): readonly IScopeHandle[] {
    return this.agentLifecycle.list();
  }

  fork(): Promise<IScopeHandle> {
    throw new Error('TODO: SessionService.fork');
  }
  listChildren(): readonly IScopeHandle[] {
    return [];
  }
  compact(): Promise<void> {
    throw new Error('TODO: SessionService.compact');
  }
  undo(): Promise<void> {
    throw new Error('TODO: SessionService.undo');
  }
  archive(): Promise<void> {
    throw new Error('TODO: SessionService.archive');
  }
}

registerScopedService(LifecycleScope.Session, ISessionService, SessionService, InstantiationType.Delayed, 'session');
