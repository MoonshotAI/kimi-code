/**
 * `log` domain (L1) — `ISessionLogService` implementation.
 *
 * Per-session logger: binds `sessionId` to every entry and writes to the
 * Session-scoped `ILogWriterService` (a rotating file writer owned by the Session scope).
 * Bound at Session scope (Delayed) so sessions that never emit logs allocate
 * nothing.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionContext } from '#/session-context';

import { ILogWriterService, ISessionLogService } from './log';
import { ILogOptions } from './logConfig';
import { BoundLogger, type LogLevelState } from './logService';

export class SessionLogService extends BoundLogger implements ISessionLogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ILogWriterService writer: ILogWriterService,
    @ILogOptions options: ILogOptions,
    @ISessionContext session: ISessionContext,
  ) {
    const levelState: LogLevelState = { level: options.level };
    super(writer, levelState, { sessionId: session.sessionId });
  }

  flush(): Promise<void> {
    return this.writer.flush?.() ?? Promise.resolve();
  }

  close(): Promise<void> {
    return this.writer.close?.() ?? Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionLogService,
  SessionLogService,
  InstantiationType.Delayed,
  'log',
);
