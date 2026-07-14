/**
 * `sessionLog` domain — Session-scope `ILogService` implementation.
 *
 * Binds `sessionId` to every entry and writes to a rotating file under
 * `<sessionDir>/logs` (the `sessionId` key is omitted from each line since the
 * path already identifies the session). Registered to the single `ILogService`
 * token at Session scope, so every Session/Agent consumer injecting
 * `@ILogService` lands here (Agent has no own binding and falls back to this).
 * Flushes synchronously when the Session scope is disposed.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ILogService, type LogLevel } from '#/_base/log/log';
import { createFileLogWriter, type FileLogWriter } from '#/_base/log/fileLog';
import { ILogOptions, resolveSessionLogPath } from '#/_base/log/logConfig';
import { BoundLogger, type LogLevelState } from '#/_base/log/logService';

export class SessionLogService extends BoundLogger implements ILogService {
  declare readonly _serviceBrand: undefined;
  private readonly sink: FileLogWriter;
  private readonly rootLevel: LogLevelState;

  constructor(
    @ILogOptions options: ILogOptions,
    @ISessionContext session: ISessionContext,
  ) {
    const sink = createFileLogWriter({
      path: resolveSessionLogPath(session.sessionDir),
      maxBytes: options.sessionMaxBytes,
      files: options.sessionFiles,
      format: { omitContextKeys: ['sessionId'] },
    });
    const rootLevel: LogLevelState = { level: options.level };
    super(sink, rootLevel, { sessionId: session.sessionId });
    this.sink = sink;
    this.rootLevel = rootLevel;
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
  InstantiationType.Eager,
  'log',
);
