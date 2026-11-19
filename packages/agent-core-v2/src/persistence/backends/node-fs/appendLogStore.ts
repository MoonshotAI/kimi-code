import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { AppendLogStore as CoreAppendLogStore } from '@moonshot-ai/core/store/append-log';
import type { LogArgs } from '@moonshot-ai/core/utils/log';

import { AppendLogCorruptedError, IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError } from '#/persistence/interface/storage';

export { drainAppendLogRetirements } from '@moonshot-ai/core/store/append-log';

export class AppendLogStore extends CoreAppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileSystemStorageService storage: IFileSystemStorageService,
    @ILogService logger: ILogService,
  ) {
    super(storage, {
      logger: {
        warn: (...args: LogArgs) => {
          if (args.length === 1) logger.warn(args[0]);
          else logger.warn(args[1], args[0]);
        },
      },
      createStorageError: (code, message, options) => new StorageError(code, message, options),
      createCorruptedError: (scope, key, lineNumber, cause) => new AppendLogCorruptedError(scope, key, lineNumber, cause),
      onUnexpectedError,
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IAppendLogStore,
  AppendLogStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
