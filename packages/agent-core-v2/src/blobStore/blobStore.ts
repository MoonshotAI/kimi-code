import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface BlobStoreServiceOptions {
  readonly blobsDir?: string;
  readonly threshold?: number;
  readonly maxCacheSize?: number;
}

export interface IBlobStoreService {
  offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  rehydrateParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IBlobStoreService = createDecorator<IBlobStoreService>(
  'agentBlobStoreService',
);
