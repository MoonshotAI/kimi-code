import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import type { Event } from '#/_base/event';

import { SessionErrors } from '#/session/errors';

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
    '该会话正在被其他 Kimi Code 进程使用；请停止其他进程中的会话或退出该进程后重试',
    { details: { sessionId, holder } },
  );
}

export function sessionStaleError(sessionId: string): Error2 {
  return new Error2(
    SessionErrors.codes.SESSION_STALE,
    `Session "${sessionId}" was updated by another client; reload it before continuing`,
    { details: { sessionId } },
  );
}

const lastCheckedTokens = new Map<string, string>();

export function beginSessionRun(
  locks: ISessionLockService,
  log: IAppendLogStore,
  sessionId: string,
  wireScope: string,
  wireKey: string,
): void {
  locks.beginRun(sessionId);
  const token = locks.holdToken(sessionId);
  if (token !== undefined && token === lastCheckedTokens.get(sessionId)) return;
  if (!log.externallyModified(wireScope, wireKey)) {
    if (token !== undefined) lastCheckedTokens.set(sessionId, token);
    return;
  }
  lastCheckedTokens.delete(sessionId);
  locks.endRun(sessionId);
  throw sessionStaleError(sessionId);
}
