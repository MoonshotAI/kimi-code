import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import {
  SESSION_INDEX_MANIFEST,
  sessionCollection,
  sessionCountersCollection,
  type SessionWorkspaceCounts,
} from '#/app/sessionIndex/sessionIndexModel';
import {
  drainSessionIndexMirror,
  SessionIndexMirror,
} from '#/app/sessionIndex/sessionIndexMirrorService';
import { drainQueryStoreDisposals, MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { IQueryStore } from '#/persistence/interface/queryStore';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';

const WORKSPACE = 'wd_test';
const GENERATION = 1;

function summary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    ...overrides,
  };
}

describe('SessionIndexMirror', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;
  let queryStore: IQueryStore;
  let mirror: ISessionIndexMirror;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndexMirror,
      SessionIndexMirror,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'session-mirror-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  async function publishGeneration(): Promise<void> {
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: GENERATION });
  }

  function build(flagEnabled = true): ISessionIndexMirror {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(flagEnabled)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    return mirror;
  }

  it('coalesces updates per session and drains summaries with counters', async () => {
    build();
    await publishGeneration();

    mirror.record(summary('a', { title: 'first', updatedAt: 1 }));
    mirror.record(summary('a', { title: 'latest', updatedAt: 5 }));
    mirror.record(summary('b', { archived: true, updatedAt: 3 }));
    expect(mirror.pending().map((s) => s.id).sort()).toEqual(['a', 'b']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);

    const stored = await queryStore.getMany<{ title?: string; archived: boolean }>(
      sessionCollection(GENERATION),
      ['a', 'b'],
    );
    expect(stored.get('a')).toMatchObject({ title: 'latest', archived: false });
    expect(stored.get('b')).toMatchObject({ archived: true });

    const counters = await queryStore.getMany<SessionWorkspaceCounts>(
      sessionCountersCollection(GENERATION),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 1, archived: 1 });
  });

  it('tracks archive transitions against the stored summary', async () => {
    build();
    await publishGeneration();
    await queryStore.put(sessionCollection(GENERATION), 'a', summary('a'), {
      columns: { updatedAt: 2 },
    });
    await queryStore.put(sessionCountersCollection(GENERATION), WORKSPACE, {
      active: 1,
      archived: 0,
    } satisfies SessionWorkspaceCounts);

    mirror.record(summary('a', { archived: true, updatedAt: 9 }));
    await mirror.drain();

    const counters = await queryStore.getMany<SessionWorkspaceCounts>(
      sessionCountersCollection(GENERATION),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 0, archived: 1 });
  });

  it('is a no-op when the read-model flag is off', async () => {
    build(false);
    mirror.record(summary('a'));
    expect(mirror.pending()).toEqual([]);
    await mirror.drain();
  });

  it('never blocks record on the query store', async () => {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    // Hang the store: every manifest read takes a second. record() must stay
    // synchronous regardless — the user mutation path never waits.
    const real = queryStore.getCheckpoint.bind(queryStore);
    queryStore.getCheckpoint = async (source: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return real(source);
    };
    mirror = host.app.accessor.get(ISessionIndexMirror);

    const t0 = performance.now();
    for (let i = 0; i < 600; i++) {
      mirror.record(summary(`s${i}`, { updatedAt: i }));
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(mirror.pending().length).toBe(600);
  }, 10_000);

  it('keeps entries queued when no generation is published yet', async () => {
    build();
    mirror.record(summary('a'));
    await mirror.drain();
    // Nothing lost: without a published generation the entries stay queued
    // (the running projection covers them from the authoritative documents).
    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);
  });

  it('retries a failed flush instead of dropping entries', async () => {
    build();
    await publishGeneration();

    const realBatch = queryStore.batch.bind(queryStore);
    let failures = 1;
    queryStore.batch = async (ops) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('injected flush failure');
      }
      return realBatch(ops);
    };

    mirror.record(summary('a', { updatedAt: 7 }));
    await mirror.drain();
    // The first drain attempt failed; the entries must still be queued.
    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);
    expect(await queryStore.get(sessionCollection(GENERATION), 'a')).toMatchObject({
      id: 'a',
    });
  });
});
