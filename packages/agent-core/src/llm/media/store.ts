import type { MediaContent, MediaSource } from './source';

export interface MediaStore extends MediaSource {
  put(content: MediaContent): Promise<string>;
}
