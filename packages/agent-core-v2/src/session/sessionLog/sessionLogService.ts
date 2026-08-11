/**
 * `sessionLog` domain — Session-scope `ILogService` implementation.
 *
 * Binds `sessionId` to every entry and writes to a rotating file under
 * `<sessionDir>/logs` (the `sessionId` key is omitted from each line since the
 * path already identifies the session). Registered to the single `ILogService`
 * token at Session scope. Flushes synchronously when the Session scope is
 * disposed. The plain-data state (`rootLevel`) is registered into
 * `sessionState` (`ISessionStateService`) and read/written through it.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import { ILogService, type LogLevel } from '#/_base/log/log';
import { createFileLogWriter, type FileLogWriter } from '#/_base/log/fileLog';
import { ILogOptions, resolveSessionLogPath } from '#/_base/log/logConfig';
import { BoundLogger, type LogLevelState } from '#/_base/log/logService';

export const sessionLogRootLevelKey = defineState<LogLevelState>('sessionLog.rootLevel', () => ({
  level: 'info',
}));

function seedRootLevel(states: ISessionStateService, level: LogLevel): LogLevelState {
  states.register(sessionLogRootLevelKey);
  states.set(sessionLogRootLevelKey, { level });
  return states.get(sessionLogRootLevelKey);
}

export class SessionLogService extends BoundLogger implements ILogService {
  declare readonly _serviceBrand: undefined;
  private readonly sink: FileLogWriter;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ILogOptions options: ILogOptions,
    @ISessionContext session: ISessionContext,
  ) {
    const sink = createFileLogWriter({
      path: resolveSessionLogPath(session.sessionDir),
      maxBytes: options.sessionMaxBytes,
      files: options.sessionFiles,
      format: { omitContextKeys: ['sessionId'] },
    });
    super(sink, seedRootLevel(states, options.level), { sessionId: session.sessionId });
    this.sink = sink;
  }

  private get rootLevel(): LogLevelState {
    return this.states.get(sessionLogRootLevelKey);
  }

  get level(): LogLevel {
    return this.rootLevel.level;
  }

  setLevel(level: LogLevel): void {
    this.rootLevel.level = level;
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }

  close(): Promise<void> {
    return this.sink.close();
  }

  override dispose(): void {
    this.sink.flushSync();
    void this.sink.close();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ILogService,
  SessionLogService,
  ScopeActivation.OnScopeCreated,
  'log',
);
