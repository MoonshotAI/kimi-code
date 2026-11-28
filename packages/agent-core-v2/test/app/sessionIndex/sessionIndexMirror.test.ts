import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { deferred } from '@moonshot-ai/testkit/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import {
  SESSION_INDEX_MANIFEST,
  sessionCollection,
  sessionCountersCollection,
  type SessionProjectCounts,
} from '#/app/sessionIndex/sessionIndexModel';
import {
  drainSessionIndexMirror,
  SessionIndexMirror,
} from '#/app/sessionIndex/sessionIndexMirrorService';
import { drainQueryStoreDisposals, MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { DATABASE_SECTION } from '#/persistence/configSection';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubConfigService } from '../config/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';
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

  function build(
    baseEnabled = true,
    telemetry: ITelemetryService = noopTelemetryService,
  ): ISessionIndexMirror {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IFileSystemStorageService, new FileStorageService(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IConfigService, stubConfigService({ [DATABASE_SECTION]: { base: baseEnabled } })),
      stubPair(ITelemetryService, telemetry),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    return mirror;
  }

  it('runs exclusive work only after the flush in flight has written', async () => {
    build();
    await publishGeneration();
    const entered = deferred();
    const release = deferred();
    let flushed = false;
    const batch = queryStore.batch.bind(queryStore);
    vi.spyOn(queryStore, 'batch').mockImplementation(async (ops) => {
      entered.resolve();
      await release.promise;
      await batch(ops);
      flushed = true;
    });

    mirror.record(summary('a'));
    const draining = mirror.drain();
    await entered.promise;
    const sawFlush = mirror.runExclusive(async () => flushed);
    release.resolve();

    await expect(sawFlush).resolves.toBe(true);
    await draining;
  });

  it('rereads a consistent value when exclusive work writes during the read', async () => {
    build();
    await publishGeneration();
    let reads = 0;

    const value = await mirror.readConsistently(async () => {
      reads += 1;
      if (reads === 1) await mirror.runExclusive(async () => {});
      return reads;
    });

    expect(value).toBe(2);
  });

  it('reads only after the exclusive work in progress has finished', async () => {
    build();
    await publishGeneration();
    const started = deferred();
    let working = true;
    const exclusive = mirror.runExclusive(async () => {
      started.resolve();
      await fsp.readdir(homeDir);
      working = false;
    });
    await started.promise;

    const readWhileWorking = await mirror.readConsistently(async () => working);

    expect(readWhileWorking).toBe(false);
    await exclusive;
  });

  it.each<{
    placement: string;
    primaries?: Record<string, string>;
    recorded: Record<string, unknown>;
    cwd: string;
  }>([
    {
      placement: 'that follows the project primary',
      primaries: { [WORKSPACE]: '/new' },
      recorded: { cwd: '/old' },
      cwd: '/new',
    },
    {
      placement: 'pinned to its own directory',
      primaries: { [WORKSPACE]: '/new' },
      recorded: { cwd: '/old', environmentCwd: '/pinned' },
      cwd: '/pinned',
    },
    {
      placement: 'in a remote environment',
      primaries: { [WORKSPACE]: '/new' },
      recorded: { cwd: '/remote', environmentId: 'devbox' },
      cwd: '/remote',
    },
    {
      placement: 'whose project the generation has no primary for',
      primaries: {},
      recorded: { cwd: '/fresh' },
      cwd: '/fresh',
    },
    {
      placement: 'when the generation records no primaries',
      recorded: { cwd: '/fresh' },
      cwd: '/fresh',
    },
  ])('writes the working directory of a session $placement under the primaries of the generation', async ({ primaries, recorded, cwd }) => {
    build();
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, {
      seq: GENERATION,
      workspacePrimaries: primaries,
    });

    mirror.record(summary('a', recorded));
    await mirror.drain();

    const stored = await queryStore.getMany<{ cwd?: string }>(sessionCollection(GENERATION), ['a']);
    expect(stored.get('a')?.cwd).toBe(cwd);
  });

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

    const counters = await queryStore.getMany<SessionProjectCounts>(
      sessionCountersCollection(GENERATION),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 1, archived: 1 });
  });

  it('keeps a summary flushed while flushes are retained visible and writes it into the generation published afterwards', async () => {
    build();
    await publishGeneration();

    const retention = mirror.retainFlushes();
    mirror.record(summary('a', { updatedAt: 5 }));
    await mirror.drain();
    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);
    expect((await queryStore.getMany(sessionCollection(GENERATION), ['a'])).has('a')).toBe(true);

    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: GENERATION + 1 });
    retention.dispose();
    await mirror.drain();

    expect(mirror.pending()).toEqual([]);
    const stored = await queryStore.getMany<{ updatedAt: number }>(sessionCollection(GENERATION + 1), ['a']);
    expect(stored.get('a')).toMatchObject({ updatedAt: 5 });
    const counters = await queryStore.getMany<SessionProjectCounts>(
      sessionCountersCollection(GENERATION + 1),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 1, archived: 0 });
  });

  it('does not write back a retained summary that was evicted before the retention ends', async () => {
    build();
    await publishGeneration();

    const retention = mirror.retainFlushes();
    mirror.record(summary('a'));
    await mirror.drain();
    await mirror.evict('a');
    expect(mirror.pending()).toEqual([]);

    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: GENERATION + 1 });
    retention.dispose();
    await mirror.drain();

    expect((await queryStore.getMany(sessionCollection(GENERATION + 1), ['a'])).has('a')).toBe(false);
  });

  it('keeps a summary pending when a new generation is published while it is being flushed', async () => {
    build();
    await publishGeneration();
    const batch = queryStore.batch.bind(queryStore);
    let republished = false;
    queryStore.batch = async (ops) => {
      await batch(ops);
      if (republished) return;
      republished = true;
      await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: GENERATION + 1 });
    };

    mirror.record(summary('a', { updatedAt: 5 }));
    await mirror.drain();

    expect(mirror.pending()).toEqual([]);
    const stored = await queryStore.getMany<{ updatedAt: number }>(sessionCollection(GENERATION + 1), ['a']);
    expect(stored.get('a')).toMatchObject({ updatedAt: 5 });
    const counters = await queryStore.getMany<SessionProjectCounts>(
      sessionCountersCollection(GENERATION + 1),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 1, archived: 0 });
  });

  it('keeps a written summary pending when the manifest cannot be read back after the flush', async () => {
    build();
    await publishGeneration();
    const batch = queryStore.batch.bind(queryStore);
    const getCheckpoint = queryStore.getCheckpoint.bind(queryStore);
    let failReadBack = true;
    let batchLanded = false;
    queryStore.batch = async (ops) => {
      await batch(ops);
      batchLanded = true;
    };
    queryStore.getCheckpoint = async (source) => {
      if (batchLanded && failReadBack) {
        failReadBack = false;
        throw new Error('injected checkpoint read failure');
      }
      return getCheckpoint(source);
    };

    mirror.record(summary('a', { updatedAt: 5 }));
    await mirror.drain();
    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);
    const counters = await queryStore.getMany<SessionProjectCounts>(
      sessionCountersCollection(GENERATION),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 1, archived: 0 });
  });

  it('stops draining when every flush keeps landing in a generation that was just replaced', async () => {
    build();
    await publishGeneration();
    const batch = queryStore.batch.bind(queryStore);
    const getCheckpoint = queryStore.getCheckpoint.bind(queryStore);
    let batches = 0;
    queryStore.batch = async (ops) => {
      await batch(ops);
      batches += 1;
    };
    let reads = 0;
    queryStore.getCheckpoint = async (source) => {
      const checkpoint = await getCheckpoint(source);
      reads += 1;
      return reads % 2 === 0 && checkpoint !== undefined ? { ...checkpoint, seq: checkpoint.seq + 1 } : checkpoint;
    };

    mirror.record(summary('a'));
    await mirror.drain();

    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);
    expect(batches).toBe(4);
  });

  it('keeps a summary pending when the retention ends while its flush is finishing', async () => {
    build();
    await publishGeneration();
    const retention = mirror.retainFlushes();
    const batch = queryStore.batch.bind(queryStore);
    const getCheckpoint = queryStore.getCheckpoint.bind(queryStore);
    let batchLanded = false;
    queryStore.batch = async (ops) => {
      await batch(ops);
      batchLanded = true;
    };
    queryStore.getCheckpoint = async (source) => {
      const value = await getCheckpoint(source);
      if (batchLanded) {
        batchLanded = false;
        await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: GENERATION + 1 });
        retention.dispose();
      }
      return value;
    };

    mirror.record(summary('a', { updatedAt: 5 }));
    await mirror.drain();

    expect(mirror.pending()).toEqual([]);
    const stored = await queryStore.getMany<{ updatedAt: number }>(sessionCollection(GENERATION + 1), ['a']);
    expect(stored.get('a')).toMatchObject({ updatedAt: 5 });
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
    } satisfies SessionProjectCounts);

    mirror.record(summary('a', { archived: true, updatedAt: 9 }));
    await mirror.drain();

    const counters = await queryStore.getMany<SessionProjectCounts>(
      sessionCountersCollection(GENERATION),
      [WORKSPACE],
    );
    expect(counters.get(WORKSPACE)).toEqual({ active: 0, archived: 1 });
  });

  it('is a no-op when the read model is disabled', async () => {
    build(false);
    mirror.record(summary('a'));
    expect(mirror.pending()).toEqual([]);
    await mirror.drain();
  });

  it('never blocks record on the query store', async () => {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IFileSystemStorageService, new FileStorageService(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IConfigService, stubConfigService({ [DATABASE_SECTION]: { base: true } })),
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
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
    expect(mirror.pending().map((s) => s.id)).toEqual(['a']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);
    expect(await queryStore.get(sessionCollection(GENERATION), 'a')).toMatchObject({
      id: 'a',
    });
  });

  it('tracks the give-up event once per consecutive failure episode', async () => {
    const records: TelemetryRecord[] = [];
    build(true, recordingTelemetry(records));
    await publishGeneration();

    const realBatch = queryStore.batch.bind(queryStore);
    queryStore.batch = async () => {
      throw new Error('injected flush failure');
    };
    const giveUps = (): TelemetryRecord[] =>
      records.filter((record) => record.event === 'session_index_mirror_give_up');

    mirror.record(summary('a'));
    for (let i = 0; i < 8; i++) await mirror.drain();
    expect(giveUps()).toHaveLength(1);
    expect(giveUps()[0]?.properties).toMatchObject({
      pending_count: 1,
      consecutive_failures: 5,
    });

    queryStore.batch = realBatch;
    await mirror.drain();
    expect(mirror.pending()).toEqual([]);

    queryStore.batch = async () => {
      throw new Error('injected flush failure');
    };
    mirror.record(summary('a', { updatedAt: 9 }));
    for (let i = 0; i < 6; i++) await mirror.drain();
    expect(giveUps()).toHaveLength(2);
  });

  it('tracks the give-up event when unpublished flushes precede a throwing one', async () => {
    const records: TelemetryRecord[] = [];
    build(true, recordingTelemetry(records));

    mirror.record(summary('a'));
    for (let i = 0; i < 5; i++) await mirror.drain();
    expect(records).toEqual([]);

    await publishGeneration();
    queryStore.batch = async () => {
      throw new Error('injected flush failure');
    };
    for (let i = 0; i < 3; i++) await mirror.drain();
    const giveUps = records.filter((record) => record.event === 'session_index_mirror_give_up');
    expect(giveUps).toHaveLength(1);
    expect(giveUps[0]?.properties).toMatchObject({
      pending_count: 1,
      consecutive_failures: 6,
    });
  });
});
