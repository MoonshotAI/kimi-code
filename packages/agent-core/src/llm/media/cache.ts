import type { MediaFileRef } from './upload';

export interface MediaUploadCache {
  get(ref: string, providerKey: string): Promise<MediaFileRef | undefined>;
  put(ref: string, providerKey: string, part: MediaFileRef): Promise<void>;
}
