/**
 * Server instance registry semantics (plan P0 — multi-server shared homedir).
 *
 * Hermetic strategy: every test uses a tmpdir instances dir so the real
 * `~/.kimi-code/server/instances` is never touched. Dead-pid simulation uses
 * `0x7fffffff` (guaranteed ESRCH on Linux/macOS), mirroring lock.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createInstanceRegistry,
  getLiveServerInstance,
  listLiveServerInstances,
  type ServerInstanceInfo,
} from '../src/instanceRegistry';

let tmpDir: string;
let instancesDir: string;

/** Max signed-32 pid; the kernel never allocates it, so `kill(pid, 0)` → ESRCH. */
const DEAD_PID = 0x7fffffff;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-instance-registry-test-'));
  instancesDir = join(tmpDir, 'instances');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface DiskInstance {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  started_at: number;
  heartbeat_at: number;
  host_version?: string;
}

function writeInstance(serverId: string, fields: Partial<DiskInstance> & { pid: number }): void {
  mkdirSync(instancesDir, { recursive: true });
  const disk: DiskInstance = {
    server_id: serverId,
    pid: fields.pid,
    host: fields.host ?? '127.0.0.1',
    port: fields.port ?? 58627,
    started_at: fields.started_at ?? 1000,
    heartbeat_at: fields.heartbeat_at ?? 1000,
    ...(fields.host_version !== undefined ? { host_version: fields.host_version } : {}),
  };
  writeFileSync(join(instancesDir, `${serverId}.json`), JSON.stringify(disk));
}

function readInstance(serverId: string): DiskInstance {
  return JSON.parse(readFileSync(join(instancesDir, `${serverId}.json`), 'utf8')) as DiskInstance;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const baseInfo = {
  pid: process.pid,
  host: '127.0.0.1',
  port: 58627,
  startedAt: 1000,
};

describe('createInstanceRegistry — register / release', () => {
  it('writes a <serverId>.json file and release removes it', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 2000 });
    const reg = await registry.register(baseInfo);

    expect(typeof reg.serverId).toBe('string');
    expect(reg.serverId.length).toBeGreaterThan(0);
    const filePath = join(instancesDir, `${reg.serverId}.json`);
    expect(existsSync(filePath)).toBe(true);
    expect(readInstance(reg.serverId)).toEqual({
      server_id: reg.serverId,
      pid: process.pid,
      host: '127.0.0.1',
      port: 58627,
      started_at: 1000,
      heartbeat_at: 2000,
    });

    await reg.release();
    expect(existsSync(filePath)).toBe(false);
  });

  it('records host_version when provided', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    const reg = await registry.register({ ...baseInfo, hostVersion: '1.2.3' });
    expect(readInstance(reg.serverId).host_version).toBe('1.2.3');
    await reg.release();
  });

  it('assigns distinct serverIds to concurrent registrations', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    const a = await registry.register(baseInfo);
    const b = await registry.register(baseInfo);
    expect(a.serverId).not.toBe(b.serverId);
    await a.release();
    await b.release();
  });

  it('release is idempotent', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    const reg = await registry.register(baseInfo);
    await reg.release();
    await expect(reg.release()).resolves.toBeUndefined();
  });

  it('update is a no-op after release', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    const reg = await registry.register(baseInfo);
    const filePath = join(instancesDir, `${reg.serverId}.json`);
    await reg.release();
    await expect(reg.update({ port: 9999 })).resolves.toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('createInstanceRegistry — stale sweep on register', () => {
  it('removes dead-pid entries and keeps live ones when registering', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    // Pre-seed a stale (dead pid) and a live entry before registering.
    writeInstance('stale', { pid: DEAD_PID });
    writeInstance('live-peer', { pid: process.pid, started_at: 500 });

    const reg = await registry.register(baseInfo);

    expect(existsSync(join(instancesDir, 'stale.json'))).toBe(false);
    expect(existsSync(join(instancesDir, 'live-peer.json'))).toBe(true);
    expect(existsSync(join(instancesDir, `${reg.serverId}.json`))).toBe(true);
    await reg.release();
  });

  it('leaves unparseable entries alone (may be a live peer mid-write)', async () => {
    const registry = createInstanceRegistry({ instancesDir, now: () => 1 });
    mkdirSync(instancesDir, { recursive: true });
    writeFileSync(join(instancesDir, 'garbage.json'), '{not valid');
    const reg = await registry.register(baseInfo);
    expect(existsSync(join(instancesDir, 'garbage.json'))).toBe(true);
    await reg.release();
  });
});

describe('createInstanceRegistry — listLive', () => {
  it('returns live instances, drops dead ones, and sorts by startedAt', async () => {
    const registry = createInstanceRegistry({ instancesDir });
    writeInstance('dead', { pid: DEAD_PID, started_at: 1 });
    writeInstance('older', { pid: process.pid, started_at: 100 });
    writeInstance('newer', { pid: process.pid, started_at: 200 });

    const live = await registry.listLive();
    expect(live.map((i) => i.serverId)).toEqual(['older', 'newer']);
    // Dead entry lazily removed as a side effect.
    expect(existsSync(join(instancesDir, 'dead.json'))).toBe(false);
  });

  it('returns an empty array when the directory is missing', async () => {
    const registry = createInstanceRegistry({ instancesDir });
    await expect(registry.listLive()).resolves.toEqual([]);
  });
});

describe('createInstanceRegistry — update', () => {
  it('rewrites the port and refreshes heartbeatAt', async () => {
    let t = 1000;
    const registry = createInstanceRegistry({ instancesDir, now: () => t });
    const reg = await registry.register(baseInfo);
    expect(readInstance(reg.serverId).port).toBe(58627);
    expect(readInstance(reg.serverId).heartbeat_at).toBe(1000);

    t = 2000;
    await reg.update({ port: 58628 });

    const after = readInstance(reg.serverId);
    expect(after.port).toBe(58628);
    expect(after.heartbeat_at).toBe(2000);
    // Other fields preserved.
    expect(after.pid).toBe(process.pid);
    expect(after.started_at).toBe(1000);
    await reg.release();
  });

  it('refreshes heartbeat without changing port when patch is empty', async () => {
    let t = 1000;
    const registry = createInstanceRegistry({ instancesDir, now: () => t });
    const reg = await registry.register(baseInfo);
    t = 3000;
    await reg.update({});
    const after = readInstance(reg.serverId);
    expect(after.port).toBe(58627);
    expect(after.heartbeat_at).toBe(3000);
    await reg.release();
  });
});

describe('createInstanceRegistry — heartbeat', () => {
  it('periodically rewrites heartbeatAt until released', async () => {
    let tick = 0;
    const registry = createInstanceRegistry({
      instancesDir,
      // 1ms cadence keeps a write in flight at almost every moment, so
      // `release()` is exercised against the recreate-after-unlink race.
      heartbeatIntervalMs: 1,
      now: () => ++tick,
    });
    const reg = await registry.register(baseInfo);
    const first = readInstance(reg.serverId).heartbeat_at;

    await sleep(90);
    const later = readInstance(reg.serverId).heartbeat_at;
    expect(later).toBeGreaterThan(first);

    await reg.release();
    // File is gone after release, and a heartbeat write that was in flight
    // when release() ran must not recreate it.
    expect(existsSync(join(instancesDir, `${reg.serverId}.json`))).toBe(false);
    await sleep(30);
    expect(existsSync(join(instancesDir, `${reg.serverId}.json`))).toBe(false);
  });
});

describe('convenience readers', () => {
  it('listLiveServerInstances reads <homeDir>/server/instances', async () => {
    const dir = join(tmpDir, 'server', 'instances');
    const registry = createInstanceRegistry({ instancesDir: dir });
    const reg = await registry.register({ ...baseInfo, startedAt: 100 });

    const live = await listLiveServerInstances(tmpDir);
    expect(live.map((i: ServerInstanceInfo) => i.serverId)).toEqual([reg.serverId]);
    await reg.release();
  });

  it('getLiveServerInstance returns the longest-running live instance', async () => {
    const dir = join(tmpDir, 'server', 'instances');
    const registry = createInstanceRegistry({ instancesDir: dir });
    const older = await registry.register({ ...baseInfo, startedAt: 100 });
    const newer = await registry.register({ ...baseInfo, startedAt: 200 });

    const first = await getLiveServerInstance(tmpDir);
    expect(first?.serverId).toBe(older.serverId);
    await older.release();
    await newer.release();
  });

  it('getLiveServerInstance returns undefined when no live instance exists', async () => {
    await expect(getLiveServerInstance(tmpDir)).resolves.toBeUndefined();
  });
});
