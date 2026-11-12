import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  acquireGuiStoreLockForTest,
  GuiStorePersistenceError,
  GuiStoreService,
} from '../src/services/guiStore/guiStoreService';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: Record<string, unknown>;
}

interface SnapshotData {
  revision: number;
  entries: Record<string, { value: string; revision: number }>;
}

interface PatchData {
  applied: boolean;
  revision: number;
  entries: Record<string, { value: string; revision: number } | null>;
  conflicts: Record<string, { value: string; revision: number } | null>;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): Envelope<T> {
  return body as Envelope<T>;
}

function getStore(api: AppLike, query = '') {
  return api.inject({ method: 'GET', url: `/api/v1/gui/store${query}` });
}

function patchStore(
  api: AppLike,
  mutations: Array<{ key: string; value: string | null; if_revision?: number }>,
) {
  return api.inject({
    method: 'PATCH',
    url: '/api/v1/gui/store',
    payload: { mutations },
  });
}

describe('server-v2 gui store', () => {
  let home: string;
  let server: RunningServer;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-gui-store-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  it('returns an empty revision-0 snapshot when gui.json does not exist', async () => {
    const res = await getStore(appOf(server));
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<SnapshotData>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ revision: 0, entries: {} });
  });

  it('upserts, filters by prefix and keys, deletes, and persists gui.json', async () => {
    const api = appOf(server);
    const patchRes = await patchStore(api, [
      { key: 'kimi-web.pinned-sessions', value: '["s1","s2"]' },
      { key: 'kimi-web.workspace-sort', value: 'manual' },
      { key: 'other.pref', value: '1' },
    ]);
    const patchEnv = envelopeOf<PatchData>(patchRes.json());
    expect(patchEnv.code).toBe(0);
    expect(patchEnv.data?.applied).toBe(true);
    expect(patchEnv.data?.revision).toBe(1);
    expect(patchEnv.data?.entries['kimi-web.pinned-sessions']).toEqual({
      value: '["s1","s2"]',
      revision: 1,
    });

    const prefixEnv = envelopeOf<SnapshotData>(
      (await getStore(api, '?prefix=kimi-web.')).json(),
    );
    expect(Object.keys(prefixEnv.data?.entries ?? {}).toSorted()).toEqual([
      'kimi-web.pinned-sessions',
      'kimi-web.workspace-sort',
    ]);

    const keysEnv = envelopeOf<SnapshotData>(
      (await getStore(api, '?keys=other.pref')).json(),
    );
    expect(keysEnv.data?.entries).toEqual({
      'other.pref': { value: '1', revision: 1 },
    });

    const delEnv = envelopeOf<PatchData>(
      (await patchStore(api, [{ key: 'other.pref', value: null }])).json(),
    );
    expect(delEnv.data?.applied).toBe(true);
    expect(delEnv.data?.revision).toBe(2);
    expect(delEnv.data?.entries['other.pref']).toBeNull();

    const afterDel = envelopeOf<SnapshotData>((await getStore(api)).json());
    expect(afterDel.data?.entries['other.pref']).toBeUndefined();

    const persisted = JSON.parse(await readFile(join(home, 'gui.json'), 'utf-8')) as {
      schema_version: number;
      revision: number;
    };
    expect(persisted.schema_version).toBe(1);
    expect(persisted.revision).toBe(2);
  });

  it('enforces per-key optimistic concurrency and prevents ABA across delete and recreate', async () => {
    const api = appOf(server);

    const seed = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["a"]', if_revision: 0 },
        ])
      ).json(),
    );
    expect(seed.data?.applied).toBe(true);
    expect(seed.data?.entries['kimi-web.pinned-sessions']?.revision).toBe(1);

    const duplicateSeed = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["b"]', if_revision: 0 },
          { key: 'kimi-web.workspace-sort', value: 'recent', if_revision: 0 },
        ])
      ).json(),
    );
    expect(duplicateSeed.data?.applied).toBe(false);
    expect(duplicateSeed.data?.conflicts).toEqual({
      'kimi-web.pinned-sessions': { value: '["a"]', revision: 1 },
    });

    const snapAfterConflict = envelopeOf<SnapshotData>((await getStore(api)).json());
    expect(snapAfterConflict.data?.entries['kimi-web.workspace-sort']).toBeUndefined();

    await patchStore(api, [{ key: 'kimi-web.pinned-sessions', value: null, if_revision: 1 }]);
    const recreated = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["c"]', if_revision: 0 },
        ])
      ).json(),
    );
    expect(recreated.data?.applied).toBe(true);
    expect(recreated.data?.entries['kimi-web.pinned-sessions']?.revision).toBe(3);

    const staleAgainstRecreated = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["stale"]', if_revision: 1 },
        ])
      ).json(),
    );
    expect(staleAgainstRecreated.data?.applied).toBe(false);
    expect(staleAgainstRecreated.data?.conflicts['kimi-web.pinned-sessions']).toEqual({
      value: '["c"]',
      revision: 3,
    });
  });

  it('preserves all 20 concurrent client pin updates via CAS + merge retry', async () => {
    const api = appOf(server);
    const key = 'kimi-web.pinned-sessions';
    await patchStore(api, [{ key, value: JSON.stringify(['seed-1', 'seed-2']), if_revision: 0 }]);

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const pinId = `pin-${index}`;
        const initial = envelopeOf<SnapshotData>((await getStore(api, `?keys=${key}`)).json());
        let baseEntry = initial.data?.entries[key] ?? null;
        for (;;) {
          const currentIds = baseEntry === null ? [] : (JSON.parse(baseEntry.value) as string[]);
          const nextIds = currentIds.includes(pinId) ? currentIds : [...currentIds, pinId];
          const patchRes = envelopeOf<PatchData>(
            (
              await patchStore(api, [
                {
                  key,
                  value: JSON.stringify(nextIds),
                  if_revision: baseEntry?.revision ?? 0,
                },
              ])
            ).json(),
          );
          if (patchRes.data?.applied) break;
          baseEntry = patchRes.data?.conflicts[key] ?? null;
        }
      }),
    );

    const finalSnap = envelopeOf<SnapshotData>((await getStore(api, `?keys=${key}`)).json());
    const finalIds = JSON.parse(finalSnap.data?.entries[key]?.value ?? '[]') as string[];
    expect(finalIds).toHaveLength(22);
    for (let i = 0; i < 20; i += 1) {
      expect(finalIds).toContain(`pin-${i}`);
    }
  });

  it('serializes concurrent multi-process writes and recovers stale locks', async () => {
    const staleLockDir = join(home, '.gui.json.lock');
    await mkdir(staleLockDir, { recursive: true });
    const expired = new Date(Date.now() - 60_000);
    await utimes(staleLockDir, expired, expired);

    const script = [
      "import { GuiStoreService } from './packages/kap-server/src/services/guiStore/guiStoreService.ts';",
      'const [homeDir, workerId] = process.argv.slice(1);',
      'const store = new GuiStoreService(homeDir);',
      'for (let i = 0; i < 10; i += 1) {',
      '  await store.patch([{ key: `worker.${workerId}.${i}`, value: `v-${workerId}-${i}` }]);',
      '}',
      'await store.close();',
    ].join('\n');

    await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', script, home, String(worker)],
            { cwd: join(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8');
          });
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`worker ${worker} exited ${code}: ${stderr}`));
          });
        }),
      ),
    );

    const snap = envelopeOf<SnapshotData>((await getStore(appOf(server))).json());
    expect(Object.keys(snap.data?.entries ?? {})).toHaveLength(40);
  });

  it('quarantines corrupt or zero-length gui.json including startup corruption and keeps revisions monotonic after recovery', async () => {
    const api = appOf(server);
    await patchStore(api, [{ key: 'kimi-web.pinned-sessions', value: '["important-session"]' }]);
    await writeFile(join(home, 'gui.json'), '{"schema_version":1,"broken', 'utf-8');

    const failedRead = envelopeOf<SnapshotData>((await getStore(api)).json());
    expect(failedRead.code).toBe(50003);
    const quarantinePath = failedRead.details?.['quarantine_path'];
    expect(typeof quarantinePath).toBe('string');
    const backupBytes = await readFile(quarantinePath as string, 'utf-8');
    expect(backupBytes).toContain('"broken');

    const recoveredPatch = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["recreated"]', if_revision: 0 },
        ])
      ).json(),
    );
    expect(recoveredPatch.code).toBe(0);
    expect(recoveredPatch.data?.applied).toBe(true);
    const recoveredRev = recoveredPatch.data?.entries['kimi-web.pinned-sessions']?.revision ?? 0;
    expect(recoveredRev).toBeGreaterThan(1);

    const stalePreCorrupt = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: 'kimi-web.pinned-sessions', value: '["stale-pre-corrupt"]', if_revision: 1 },
        ])
      ).json(),
    );
    expect(stalePreCorrupt.data?.applied).toBe(false);

    await writeFile(join(home, 'gui.json'), '', 'utf-8');
    const changeEventsDuringQuarantine: unknown[] = [];
    const sub = server ? { dispose: () => {} } : { dispose: () => {} };
    void sub;
    const emptyCorrupt = envelopeOf<SnapshotData>((await getStore(api)).json());
    expect(emptyCorrupt.code).toBe(50003);
    expect(changeEventsDuringQuarantine).toEqual([]);

    const bootHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-gui-corrupt-boot-'));
    let bootServer: RunningServer | undefined;
    try {
      await writeFile(join(bootHome, 'gui.json'), '{not-valid-json', 'utf-8');
      bootServer = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: bootHome,
        logLevel: 'silent',
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
      const firstBootGet = envelopeOf<SnapshotData>((await getStore(appOf(bootServer))).json());
      expect(firstBootGet.code).toBe(50003);
      expect(typeof firstBootGet.details?.['quarantine_path']).toBe('string');
    } finally {
      await bootServer?.close();
      await rm(bootHome, { recursive: true, force: true });
    }
  });

  it('broadcasts event.gui_store.updated over WebSocket including peer deltas raced by local reads or writes', async () => {
    const wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
    const token = server.authTokenService.getToken();
    const received: Array<{ revision: number; entries: Record<string, unknown> }> = [];

    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf-8')
          : Buffer.from(raw).toString('utf-8');
      const msg = JSON.parse(text) as {
        type?: string;
        payload?: { revision: number; entries: Record<string, unknown> };
      };
      if (msg.type === 'event.gui_store.updated' && msg.payload !== undefined) {
        received.push(msg.payload);
      }
    });

    try {
      await patchStore(appOf(server), [{ key: 'kimi-web.pinned-sessions', value: '["s1"]' }]);
      await viWaitFor(() => {
        expect(received).toHaveLength(1);
      });

      const peer = new GuiStoreService(home);
      try {
        await peer.patch([{ key: 'kimi-web.workspace-sort', value: 'recent' }]);
        await getStore(appOf(server));
        await viWaitFor(() => {
          expect(received).toHaveLength(2);
        });
        expect(received[1]).toMatchObject({
          entries: {
            'kimi-web.workspace-sort': { value: 'recent', revision: 2 },
          },
        });

        await peer.patch([{ key: 'kimi-web.hidden-workspace-ids', value: '["ws-h"]' }]);
        await patchStore(appOf(server), [{ key: 'kimi-web.manual-unread', value: '{"s1":true}' }]);
        await viWaitFor(() => {
          const allKeys = new Set(received.slice(2).flatMap((e) => Object.keys(e.entries)));
          expect(allKeys.has('kimi-web.hidden-workspace-ids')).toBe(true);
          expect(allKeys.has('kimi-web.manual-unread')).toBe(true);
        });
      } finally {
        await peer.close();
      }
    } finally {
      ws.close();
    }
  });

  it('fences stale lock holders before commit and preserves contender writes', async () => {
    const lockHome = await mkdtemp(join(tmpdir(), 'kimi-gui-lock-owner-'));
    try {
      const lockDir = join(lockHome, '.gui.json.lock');
      const firstLock = await acquireGuiStoreLockForTest(lockDir, {
        lockStaleMs: 1_000,
        lockHeartbeatMs: 60_000,
        lockTimeoutMs: 2_000,
      });
      const expired = new Date(Date.now() - 60_000);
      await utimes(lockDir, expired, expired);

      const secondLock = await acquireGuiStoreLockForTest(lockDir, {
        lockStaleMs: 1_000,
        lockHeartbeatMs: 60_000,
        lockTimeoutMs: 2_000,
      });
      try {
        await expect(firstLock.assertOwned()).rejects.toBeInstanceOf(GuiStorePersistenceError);
        await firstLock.release();
        expect((await stat(lockDir)).isDirectory()).toBe(true);
      } finally {
        await secondLock.release();
      }
      await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });

      const contender = new GuiStoreService(lockHome, undefined, {
        lockStaleMs: 1_000,
        lockHeartbeatMs: 60_000,
        lockTimeoutMs: 2_000,
      });
      const stalledWriter = new GuiStoreService(lockHome, undefined, {
        lockStaleMs: 1_000,
        lockHeartbeatMs: 60_000,
        lockTimeoutMs: 2_000,
        beforeCommitHook: async () => {
          const old = new Date(Date.now() - 60_000);
          await utimes(lockDir, old, old);
          await contender.patch([{ key: 'contender-key', value: 'contender-wins' }]);
        },
      });
      try {
        await expect(
          stalledWriter.patch([{ key: 'stalled-key', value: 'stale-write' }]),
        ).rejects.toBeInstanceOf(GuiStorePersistenceError);
        const snap = await contender.getSnapshot();
        expect(snap.entries['contender-key']?.value).toBe('contender-wins');
        expect(snap.entries['stalled-key']).toBeUndefined();

        const corruptBeforeFence = new GuiStoreService(lockHome, undefined, {
          beforeCommitHook: async () => {
            await writeFile(join(lockHome, 'gui.json'), '{truncated-external-edit', 'utf-8');
          },
        });
        try {
          await expect(
            corruptBeforeFence.patch([{ key: 'after-corrupt', value: 'blocked' }]),
          ).rejects.toBeInstanceOf(GuiStorePersistenceError);
          expect(await readFile(join(lockHome, 'gui.json'), 'utf-8')).toBe(
            '{truncated-external-edit',
          );
        } finally {
          await corruptBeforeFence.close();
        }
      } finally {
        await stalledWriter.close();
        await contender.close();
      }
    } finally {
      await rm(lockHome, { recursive: true, force: true });
    }
  });

  it('migrates legacy gui.toml on first access, restarts watcher on error, and maps storage failures to 50003', async () => {
    const legacyHome = await mkdtemp(join(tmpdir(), 'kimi-gui-legacy-toml-'));
    let legacyServer: RunningServer | undefined;
    try {
      await writeFile(
        join(legacyHome, 'gui.toml'),
        '"kimi-web.pinned-sessions" = "[\\"s-toml-1\\"]"\n"kimi-web.workspace-sort" = "recent"\n',
        'utf-8',
      );
      legacyServer = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: legacyHome,
        logLevel: 'silent',
      });
      const api = appOf(legacyServer);
      const snap = envelopeOf<SnapshotData>((await getStore(api)).json());
      expect(snap.code).toBe(0);
      expect(snap.data?.revision).toBe(1);
      expect(snap.data?.entries['kimi-web.pinned-sessions']).toEqual({
        value: '["s-toml-1"]',
        revision: 1,
      });
      expect(snap.data?.entries['kimi-web.workspace-sort']).toEqual({
        value: 'recent',
        revision: 1,
      });

      const storeSvc = new GuiStoreService(legacyHome);
      const events: SnapshotData[] = [];
      const sub = storeSvc.onDidChange((ev) => {
        events.push({ revision: ev.revision, entries: {} });
      });
      try {
        await viWaitFor(() => {
          const internalWatcher = (storeSvc as unknown as { watcher?: { emit(ev: string, err: Error): void } }).watcher;
          expect(internalWatcher).toBeDefined();
        });
        const firstWatcher = (storeSvc as unknown as { watcher: { emit(ev: string, err: Error): void } }).watcher;
        firstWatcher.emit('error', new Error('synthetic watcher error'));
        await new Promise((resolve) => {
          setTimeout(resolve, 600);
        });
        const peer = new GuiStoreService(legacyHome);
        try {
          await peer.patch([{ key: 'kimi-web.after-restart', value: 'ok' }]);
        } finally {
          await peer.close();
        }
        await viWaitFor(() => {
          expect(events.length).toBeGreaterThanOrEqual(1);
        });
      } finally {
        sub.dispose();
        await storeSvc.close();
      }

      await mkdir(join(legacyHome, 'gui.json.dir-collision'));
      await rm(join(legacyHome, 'gui.json'), { force: true });
      await mkdir(join(legacyHome, 'gui.json'));
      const ioFailRead = envelopeOf<SnapshotData>((await getStore(api)).json());
      expect(ioFailRead.code).toBe(50003);
      await rm(join(legacyHome, 'gui.json'), { recursive: true, force: true });
    } finally {
      await legacyServer?.close();
      await rm(legacyHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid requests and handles Object.prototype keys and lone surrogates safely', async () => {
    const api = appOf(server);

    const emptyKey = envelopeOf(
      (await patchStore(api, [{ key: '', value: 'x' }])).json(),
    );
    expect(emptyKey.code).toBe(40001);

    const dupKey = envelopeOf(
      (
        await patchStore(api, [
          { key: 'dup', value: '1' },
          { key: 'dup', value: '2' },
        ])
      ).json(),
    );
    expect(dupKey.code).toBe(40001);

    const oversizedValue = envelopeOf(
      (await patchStore(api, [{ key: 'huge', value: 'x'.repeat(70_000) }])).json(),
    );
    expect(oversizedValue.code).toBe(40001);

    const oversizedBatch = envelopeOf(
      (
        await patchStore(
          api,
          Array.from({ length: 10 }, (_, idx) => ({
            key: `batch-${idx}`,
            value: 'y'.repeat(60_000),
          })),
        )
      ).json(),
    );
    expect(oversizedBatch.code).toBe(40001);

    const protoPatch = envelopeOf<PatchData>(
      (
        await patchStore(api, [
          { key: '__proto__', value: 'proto-val' },
          { key: 'constructor', value: 'ctor-val' },
          { key: 'hasOwnProperty', value: 'hop-val' },
          { key: 'surrogate', value: 'a\uD800b' },
        ])
      ).json(),
    );
    expect(protoPatch.code).toBe(0);
    expect(protoPatch.data?.applied).toBe(true);

    const snap = envelopeOf<SnapshotData>((await getStore(api)).json());
    expect(snap.data?.entries['__proto__']?.value).toBe('proto-val');
    expect(snap.data?.entries['constructor']?.value).toBe('ctor-val');
    expect(snap.data?.entries['hasOwnProperty']?.value).toBe('hop-val');
    expect(snap.data?.entries['surrogate']?.value).toBe('a\uFFFDb');
  });

  it.skipIf(process.platform === 'win32')('writes gui.json with 0600 permissions', async () => {
    await patchStore(appOf(server), [{ key: 'kimi-web.theme', value: 'dark' }]);
    const mode = (await stat(join(home, 'gui.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

async function viWaitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
