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
  const client = holder?.clientIdentity ?? 'another client';
  return new Error2(
    SessionErrors.codes.SESSION_OCCUPIED,
    `Session "${sessionId}" is in use by ${client}`,
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

export function beginSessionRun(
  locks: ISessionLockService,
  log: IAppendLogStore,
  sessionId: string,
  wireScope: string,
  wireKey: string,
): void {
  const alreadyHeld = locks.held(sessionId);
  locks.beginRun(sessionId);
  if (alreadyHeld) return;
  if (!log.externallyModified(wireScope, wireKey)) return;
  locks.endRun(sessionId);
  throw sessionStaleError(sessionId);
}
