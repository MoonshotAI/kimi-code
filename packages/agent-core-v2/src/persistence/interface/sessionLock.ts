import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import type { Event } from '#/_base/event';

import { SessionErrors } from '#/session/errors';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';

export interface SessionLockHolder {
  readonly version: number;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
  readonly clientIdentity: string;
}

export interface SessionLockLease {
  readonly sessionId: string;
  release(): void;
}

export interface SessionLockHeldEvent {
  readonly sessionId: string;
}

export interface ISessionLockService {
  readonly _serviceBrand: undefined;

  readonly onDidHold: Event<SessionLockHeldEvent>;

  beginRun(sessionId: string): void;
  endRun(sessionId: string): void;
  acquire(sessionId: string): SessionLockLease;
  held(sessionId: string): boolean;
  holdToken(sessionId: string): string | undefined;
}

export const ISessionLockService: ServiceIdentifier<ISessionLockService> =
  createDecorator<ISessionLockService>('sessionLockService');

export function sessionOccupiedError(sessionId: string, holder?: SessionLockHolder): Error2 {
  return new Error2(
    SessionErrors.codes.SESSION_OCCUPIED,
    'This session is in use by another Kimi Code process. Stop the session in that process or exit it, then try again.',
    { details: { sessionId, holder } },
  );
}

export function beginSessionRun(
  locks: ISessionLockService,
  log: IAppendLogStore,
  sessionContext: ISessionContext,
  agents: IAgentLifecycleService,
): void {
  const sessionId = sessionContext.sessionId;
  locks.beginRun(sessionId);
  const stale = agents
    .list()
    .some((agent) =>
      log.externallyModified(
        sessionContext.scope(`agents/${agent.agentId}`),
        AGENT_WIRE_RECORD_KEY,
      ),
    );
  if (!stale) return;
  locks.endRun(sessionId);
  throw new Error2(
    SessionErrors.codes.SESSION_STALE,
    `Session "${sessionId}" was updated by another client; reload it before continuing`,
    { details: { sessionId } },
  );
}
