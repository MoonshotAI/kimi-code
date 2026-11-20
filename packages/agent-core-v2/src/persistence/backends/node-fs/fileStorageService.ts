import { FileStorageService as CoreFileStorageService } from '@moonshot-ai/core/store/backend/node';

import { IFileSystemStorageService, toStorageIoError } from '#/persistence/interface/storage';

export class FileStorageService extends CoreFileStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  constructor(baseDir: string, dirMode?: number, fileMode?: number) {
    super(baseDir, dirMode, fileMode, toStorageIoError);
  }
}
