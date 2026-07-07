/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

// `FsGitService.status` awaits `fs.realpath(cwd)` before spawning; realpath is a
// libuv/macrotask callback, which would let a microtask-only flush in the test
// runner drain before the service reaches `spawn`. Stub it to resolve on a
// microtask so the test can drive each spawn deterministically.
vi.mock('node:fs', () => ({
  promises: {
    realpath: mocks.realpath,
  },
}));

import type { ISessionService } from '../../src/services';
import { FsGitService } from '../../src/services';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  cmd: string;
  args: readonly string[];
  finish(out: string, code: number): void;
}

const spawned: FakeChild[] = [];

function createFakeChild(cmd: string, args: readonly string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.cmd = cmd;
  child.args = args;
  child.finish = (out: string, code: number) => {
    if (out.length > 0) stdout.emit('data', out);
    child.emit('close', code);
  };
  return child;
}

let ghResponse: { out: string; code: number } = { out: '', code: 1 };

const sessions = {
  get: vi.fn().mockResolvedValue({ metadata: { cwd: '/tmp/repo' } }),
} as unknown as ISessionService;

beforeEach(() => {
  spawned.length = 0;
  ghResponse = { out: '', code: 1 };
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((cmd: string, args: readonly string[]) => {
    const child = createFakeChild(cmd, args);
    spawned.push(child);
    return child;
  });
  mocks.realpath.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

async function waitForSpawn(n: number): Promise<void> {
  for (let i = 0; i < 100 && spawned.length < n; i++) {
    await flushMicrotasks();
  }
  if (spawned.length < n) {
    throw new Error(`expected at least ${String(n)} spawns, got ${String(spawned.length)}`);
  }
}

function finishLatest(out: string, code: number): void {
  const child = spawned[spawned.length - 1];
  if (child === undefined) throw new Error('no child to finish');
  child.finish(out, code);
}

async function driveStatus(service: FsGitService) {
  const p = service.status('sid', {});
  const base = spawned.length;
  await waitForSpawn(base + 1);
  finishLatest('true\n', 0);
  await waitForSpawn(base + 2);
  finishLatest('## main...origin/main\n', 0);
  let ghSpawned = false;
  for (let i = 0; i < 100; i++) {
    await flushMicrotasks();
    if (spawned.length >= base + 3) {
      ghSpawned = true;
      break;
    }
  }
  if (ghSpawned) finishLatest(ghResponse.out, ghResponse.code);
  return p;
}

describe('FsGitService pull request lookup', () => {
  it('returns a normalized pull request when gh pr view succeeds', async () => {
    ghResponse = {
      out: '{"number":12,"url":"https://github.com/acme/repo/pull/12","state":"OPEN"}\n',
      code: 0,
    };
    const service = new FsGitService(sessions);
    const result = await driveStatus(service);
    expect(result.branch).toBe('main');
    expect(result.pullRequest).toEqual({
      number: 12,
      state: 'open',
      url: 'https://github.com/acme/repo/pull/12',
    });
  });

  it('reports a draft pull request as draft state', async () => {
    ghResponse = {
      out: '{"number":7,"url":"https://github.com/acme/repo/pull/7","state":"OPEN","isDraft":true}\n',
      code: 0,
    };
    const service = new FsGitService(sessions);
    const result = await driveStatus(service);
    expect(result.pullRequest).toEqual({
      number: 7,
      state: 'draft',
      url: 'https://github.com/acme/repo/pull/7',
    });
    const gh = spawned.find((c) => c.cmd === 'gh');
    expect(gh?.args).toContain('number,url,state,isDraft');
  });

  it('returns null pull request when gh exits non-zero', async () => {
    ghResponse = { out: '', code: 1 };
    const service = new FsGitService(sessions);
    const result = await driveStatus(service);
    expect(result.branch).toBe('main');
    expect(result.pullRequest).toBeNull();
  });

  it('caches the pull request lookup within the ttl', async () => {
    ghResponse = {
      out: '{"number":1,"url":"https://github.com/acme/repo/pull/1","state":"MERGED"}\n',
      code: 0,
    };
    const service = new FsGitService(sessions);
    const first = await driveStatus(service);
    expect(first.pullRequest).toEqual({
      number: 1,
      state: 'merged',
      url: 'https://github.com/acme/repo/pull/1',
    });
    expect(spawned.filter((c) => c.cmd === 'gh')).toHaveLength(1);

    const second = await driveStatus(service);
    expect(second.pullRequest).toEqual(first.pullRequest);
    expect(spawned.filter((c) => c.cmd === 'gh')).toHaveLength(1);
  });

  it('returns null pull request when gh times out', async () => {
    vi.useFakeTimers();
    const service = new FsGitService(sessions);
    const p = service.status('sid', {});
    await waitForSpawn(1);
    finishLatest('true\n', 0);
    await waitForSpawn(2);
    finishLatest('## main...origin/main\n', 0);
    await waitForSpawn(3);
    expect(spawned[2]?.cmd).toBe('gh');
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await p;
    expect(result.pullRequest).toBeNull();
    expect(spawned[2]?.kill).toHaveBeenCalled();
  });
});
