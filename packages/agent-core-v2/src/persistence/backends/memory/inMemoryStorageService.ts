import { InMemoryStorageService as CoreInMemoryStorageService } from '@moonshot-ai/core/store/backend/memory';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export class InMemoryStorageService extends CoreInMemoryStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;
}
