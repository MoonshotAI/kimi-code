import type { BlobContent, BlobRef } from '@moonshot-ai/agent-core/blob/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import { createFacadeToken } from '#/kernel/index';
import type { FeatureEvent } from '#/runtime/index';

import type { FileMeta, StoredFile } from './store';

export interface KimiFileRecord {
  readonly meta: FileMeta;
  readonly blobRef: string;
}

export interface KimiFileRegisteredEvent extends FeatureEvent {
  readonly type: 'files.registered';
  readonly record: KimiFileRecord;
}

export type KimiFileState = Readonly<Record<string, KimiFileRecord>>;

export const kimiFileProjection: Projection<KimiFileState, KimiFileRegisteredEvent> = {
  initial: () => ({}),
  reduce: (state, { event }) => {
    if (event.type !== 'files.registered') return state;
    return { ...state, [event.record.meta.id]: event.record };
  },
};

export interface KimiFileRegistry {
  put(content: BlobContent): Promise<BlobRef>;
  get(reference: string): Promise<BlobContent | undefined>;
  open(reference: string): Promise<StoredFile | undefined>;
  materialize(reference: string): Promise<StoredFile | undefined>;
}

export const KimiFileRegistryRef = createFacadeToken<KimiFileRegistry>('kimiFileRegistry');
