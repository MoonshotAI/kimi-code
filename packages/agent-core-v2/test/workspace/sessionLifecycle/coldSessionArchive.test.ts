/**
 * Scenario: `setSessionArchivedBatch` cold-path outcome mapping.
 * Responsibilities: a metadata read failure becomes a per-item internal
 * error (never not_found), a missing metadata document is not_found, and
 * the mirrored summary is built from the authoritative persisted metadata
 * rather than a stale index copy.
 * Wiring: pure stubs — ISessionManager (serialization passthrough),
 * ISessionIndex, IAtomicDocumentStore, ISessionIndexMirror, IEventService.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/workspace/sessionLifecycle/coldSessionArchive.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  ISessionIndex,
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
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

const summary: SessionSummary = {
  id: 's1',
  workspaceId: 'wd',
  cwd: '/workspace',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
};

interface ColdPathOptions {
  readonly storeGet: () => Promise<SessionMeta | undefined>;
  readonly indexSummary?: SessionSummary;
  readonly onMirrorRecord?: (recorded: SessionSummary) => void;
  readonly onStoreSet?: (value: unknown) => void;
}

function coldPathAccessor(options: ColdPathOptions): ServicesAccessor {
  return accessor([
    [
      ISessionManager,
      {
        withLifecycleSerialization: (_id: string, work: () => Promise<unknown>) => work(),
        whenResumeSettled: async () => {},
        get: () => undefined,
      },
    ],
    [ISessionIndex, { get: async () => options.indexSummary ?? summary }],
    [IBootstrapService, { scope: () => 'sessions' }],
    [
      IAtomicDocumentStore,
      {
        get: options.storeGet,
        set: async (_scope: string, _key: string, value: unknown) => {
          options.onStoreSet?.(value);
        },
      },
    ],
    [
      ISessionIndexMirror,
      { record: (recorded: SessionSummary) => options.onMirrorRecord?.(recorded) },
    ],
    [IEventService, { publish: () => {} }],
  ]);
}

describe('setSessionArchivedBatch', () => {
  it('maps a metadata read failure to a per-item internal error, not not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => {
          throw new Error('disk on fire');
        },
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: false, reason: 'error', message: 'disk on fire' }]);
  });

  it('maps a missing metadata document to not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({ storeGet: async () => undefined }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([
      { id: 's1', ok: false, reason: 'not_found', message: 'session s1 does not exist' },
    ]);
  });

  it('mirrors the persisted metadata, not a stale index summary', async () => {
    const recorded: SessionSummary[] = [];
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        indexSummary: { ...summary, title: 'stale', lastPrompt: 'stale-p', updatedAt: 1 },
        storeGet: async () => ({
          id: 's1',
          title: 'fresh',
          lastPrompt: 'fresh-p',
          createdAt: 1,
          updatedAt: 9,
          archived: false,
        }),
        onMirrorRecord: (r) => recorded.push(r),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceId: 'wd',
      title: 'fresh',
      lastPrompt: 'fresh-p',
      updatedAt: 9,
      archived: true,
    });
    expect(typeof recorded[0]?.archivedAt).toBe('number');
  });

  it('normalizes legacy v1 metadata before persisting and mirroring', async () => {
    const recorded: SessionSummary[] = [];
    const written: unknown[] = [];
    const legacy = {
      // v1 shape: ISO-string timestamps, customTitle, workDir, no version.
      workDir: '/workspace',
      customTitle: 'legacy title',
      createdAt: '2026-07-21T19:40:00.000Z',
      updatedAt: '2026-07-22T02:00:00.000Z',
      archived: false,
    } as unknown as SessionMeta;
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => legacy,
        onMirrorRecord: (r) => recorded.push(r),
        onStoreSet: (v) => written.push(v),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);

    const rec = recorded[0];
    expect(rec?.title).toBe('legacy title');
    expect(rec?.updatedAt).toBe(Date.parse('2026-07-22T02:00:00.000Z'));

    const persisted = written[0] as Record<string, unknown>;
    expect(persisted['version']).toBe(2);
    expect(typeof persisted['updatedAt']).toBe('number');
    expect(persisted['customTitle']).toBeUndefined();
    // The v1-reader compatibility field rides the write (custom title).
    expect(persisted['isCustomTitle']).toBe(true);
  });
});
