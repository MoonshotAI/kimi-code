import { createFacadeToken } from '#/composition-api/index';

import type { ProfileCatalog } from './catalog/catalog';

export interface ProfileCatalogFace extends ProfileCatalog {
  readonly ready: Promise<void>;
  onDidChange(listener: () => void): () => void;
  reload(): Promise<void>;
}

export const ProfileCatalogRef = createFacadeToken<ProfileCatalogFace>('profiles');
