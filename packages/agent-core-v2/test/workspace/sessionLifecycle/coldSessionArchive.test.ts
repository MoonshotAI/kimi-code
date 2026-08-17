import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  setSessionArchivedBatch,
} from '#/workspace/sessionLifecycle/coldSessionArchive';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

const summary = {
  id: 's1',
  workspaceId: 'wd',
  cwd: '/workspace',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
} as const;

function coldPathAccessor(storeGet: () => Promise<unknown>): ServicesAccessor {
  return accessor([
    [
      ISessionManager,
      {
        withLifecycleSerialization: (_id: string, work: () => Promise<unknown>) => work(),
        whenResumeSettled: async () => {},
        get: () => undefined,
      },
    ],
    [ISessionIndex, { get: async () => summary }],
    [IBootstrapService, { scope: () => 'sessions' }],
    [IAtomicDocumentStore, { get: storeGet, set: async () => {} }],
    [ISessionIndexMirror, { record: () => {} }],
    [IEventService, { publish: () => {} }],
  ]);
}

describe('setSessionArchivedBatch', () => {
  it('maps a metadata read failure to a per-item internal error, not not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor(async () => {
        throw new Error('disk on fire');
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: false, reason: 'error', message: 'disk on fire' }]);
  });

  it('maps a missing metadata document to not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor(async () => undefined),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([
      { id: 's1', ok: false, reason: 'not_found', message: 'session s1 does not exist' },
    ]);
  });
});
