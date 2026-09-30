import type { MediaKind, MediaOmission } from '#/llm/message';
import type { UploadedMedia } from '#/llm/request';

export interface StoredContent {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly filename?: string;
}

export interface RefStore {
  get(ref: string): Promise<StoredContent | undefined>;
}

export interface UploadCache {
  get(ref: string, accountKey: string): Promise<UploadedMedia | undefined>;
  put(ref: string, accountKey: string, uploaded: UploadedMedia): Promise<void>;
}

export interface PlaceholderInput {
  readonly kind: MediaKind;
  readonly reason: MediaOmission;
  readonly ref?: string;
}

export type Placeholder = (
  input: PlaceholderInput,
) => Promise<string | undefined> | string | undefined;

export interface StoreRefPorts {
  readonly store: RefStore;
  readonly cache: UploadCache;
  readonly placeholder?: Placeholder;
}
