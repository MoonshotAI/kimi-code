import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export const SESSION_PRESENCE_DIR = 'presence';

export interface SessionsUnderOptions {
  readonly excludeSessionId?: string;
}

export interface SessionsUnder {
  readonly openSessionIds: readonly string[];
  readonly closedSessionCount: number;
}

export interface ISessionPresence {
  readonly _serviceBrand: undefined;

  markOpen(sessionDir: string): IDisposable;
  sessionsUnder(dir: string, options?: SessionsUnderOptions): Promise<SessionsUnder>;
}

export const ISessionPresence: ServiceIdentifier<ISessionPresence> =
  createDecorator<ISessionPresence>('sessionPresence');
