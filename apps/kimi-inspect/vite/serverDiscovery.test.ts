/**
 * Unit tests for the local server discovery middleware helpers
 * (`vite/serverDiscovery.ts`): instance/lock/token file reading, pid-liveness
 * filtering, URL normalization and dedupe. Runs in Node (mkdtemp homes).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverLocalServers,
  pidAlive,
  readLiveInstances,
  readLiveLock,
  readServerToken,
  resolveKimiHomeDir,
} from './serverDiscovery';

const ALIVE_PID = process.pid;
// Far above any realistic pid_max; must not collide with a live process.
const DEAD_PID = 999_999_999;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-inspect-discovery-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

async function writeInstance(
  id: string,
  disk: { pid: number; host?: string; port: number; started_at?: number; host_version?: string },
): Promise<void> {
  const dir = join(home, 'server', 'instances');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ server_id: id, ...disk }));
}

describe('pidAlive', () => {
  it('probes the current process as alive and a bogus pid as dead', () => {
    expect(pidAlive(ALIVE_PID)).toBe(true);
    expect(pidAlive(DEAD_PID)).toBe(false);
  });
});

describe('readLiveInstances', () => {
  it('lists live instances sorted by started_at, dropping dead pids and bad files', async () => {
    await writeInstance('b-older', { pid: ALIVE_PID, port: 58628, started_at: 100 });
    await writeInstance('a-newer', { pid: ALIVE_PID, port: 58629, started_at: 200 });
    await writeInstance('x-dead', { pid: DEAD_PID, port: 58630, started_at: 50 });
    await mkdir(join(home, 'server', 'instances'), { recursive: true });
    await writeFile(join(home, 'server', 'instances', 'garbage.json'), '{not json');

    const instances = await readLiveInstances(home);
    expect(instances.map((i) => i.id)).toEqual(['b-older', 'a-newer']);
    expect(instances[0]!.url).toBe('http://127.0.0.1:58628');
  });

  it('normalizes wildcard hosts to loopback', async () => {
    await writeInstance('wild', { pid: ALIVE_PID, host: '0.0.0.0', port: 58627, started_at: 1 });
    const instances = await readLiveInstances(home);
    expect(instances[0]!.url).toBe('http://127.0.0.1:58627');
  });

  it('returns [] when the instances directory does not exist', async () => {
    await expect(readLiveInstances(home)).resolves.toEqual([]);
  });
});

describe('readLiveLock / readServerToken', () => {
  it('reads the legacy lock only when its pid is alive', async () => {
    await mkdir(join(home, 'server'), { recursive: true });
    await writeFile(
      join(home, 'server', 'lock'),
      JSON.stringify({ pid: ALIVE_PID, port: 58627, started_at: 42 }),
    );
    expect((await readLiveLock(home))?.url).toBe('http://127.0.0.1:58627');

    await writeFile(join(home, 'server', 'lock'), JSON.stringify({ pid: DEAD_PID, port: 58627 }));
    await expect(readLiveLock(home)).resolves.toBeUndefined();
  });

  it('reads the home token, undefined when missing or empty', async () => {
    await expect(readServerToken(home)).resolves.toBeUndefined();
    await mkdir(join(home, 'server'), { recursive: true });
    await writeFile(join(home, 'server.token'), '  tok-123\n');
    await expect(readServerToken(home)).resolves.toBe('tok-123');
    await writeFile(join(home, 'server.token'), '\n');
    await expect(readServerToken(home)).resolves.toBeUndefined();
  });
});

describe('discoverLocalServers', () => {
  it('merges instances + lock + proxy target, deduped by url, with the home token', async () => {
    await writeInstance('inst', { pid: ALIVE_PID, port: 58627, started_at: 1 });
    await mkdir(join(home, 'server'), { recursive: true });
    // Lock points at another (also live) server on a different port.
    await writeFile(join(home, 'server', 'lock'), JSON.stringify({ pid: ALIVE_PID, port: 59000 }));
    await writeFile(join(home, 'server.token'), 'tok-xyz');

    const payload = await discoverLocalServers({
      homeDir: home,
      // Proxy target collides with the instance → dedupe keeps the instance.
      proxyTarget: 'http://127.0.0.1:58627/',
    });
    expect(payload.home).toBe(home);
    expect(payload.token).toBe('tok-xyz');
    expect(payload.servers.map((s) => [s.url, s.source])).toEqual([
      ['http://127.0.0.1:58627', 'instance'],
      ['http://127.0.0.1:59000', 'lock'],
    ]);
  });

  it('keeps the proxy entry when nothing else is discovered', async () => {
    const payload = await discoverLocalServers({
      homeDir: home,
      proxyTarget: 'http://127.0.0.1:58627',
    });
    expect(payload.servers).toEqual([
      { id: 'proxy', url: 'http://127.0.0.1:58627', source: 'proxy' },
    ]);
    expect(payload.token).toBeUndefined();
  });
});

describe('resolveKimiHomeDir', () => {
  it('honors KIMI_CODE_HOME, else falls back to ~/.kimi-code', () => {
    expect(resolveKimiHomeDir({ KIMI_CODE_HOME: '/tmp/kh' })).toBe('/tmp/kh');
    expect(resolveKimiHomeDir({})).toBe(join(process.env['HOME'] ?? '', '.kimi-code'));
  });
});
