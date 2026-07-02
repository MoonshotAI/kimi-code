import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { SessionAgentFileSystem, ISessionAgentFileSystem } from '#/session/agentFs';
import { IExecContext, createExecContext } from '#/session/execContext';

describe('SessionAgentFileSystem (backed by IExecContext)', () => {
  let dir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionAgentFileSystem,
      SessionAgentFileSystem,
      InstantiationType.Delayed,
      'agentFs',
    );
    dir = await mkdtemp(join(tmpdir(), 'agentfs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeFs(): Promise<ISessionAgentFileSystem> {
    const host = createScopedTestHost();
    const session = host.child(
      LifecycleScope.Session,
      's',
      [stubPair(IExecContext, createExecContext(dir))],
    );
    return session.accessor.get(ISessionAgentFileSystem);
  }

  it('writes and reads text relative to cwd', async () => {
    const fs = await makeFs();
    await fs.writeText('a.txt', 'hello');
    expect(await fs.readText('a.txt')).toBe('hello');
  });

  it('stat reports file kind and byte size', async () => {
    const fs = await makeFs();
    await fs.writeText('b.txt', 'abc');
    const st = await fs.stat('b.txt');
    expect(st.isFile).toBe(true);
    expect(st.isDirectory).toBe(false);
    expect(st.size).toBe(3);
  });

  it('stat reports directories', async () => {
    const fs = await makeFs();
    await fs.mkdir('sub');
    const st = await fs.stat('sub');
    expect(st.isDirectory).toBe(true);
    expect(st.isFile).toBe(false);
  });

  it('readdir returns entry names', async () => {
    const fs = await makeFs();
    await fs.writeText('x.txt', '');
    await fs.mkdir('sub');
    const names = [...(await fs.readdir('.'))].sort();
    expect(names).toEqual(['sub', 'x.txt']);
  });

  it('withCwd derives a sub-view rooted at the new cwd', async () => {
    const fs = await makeFs();
    await fs.mkdir('sub');
    await fs.writeText('sub/c.txt', 'deep');
    const sub = fs.withCwd(join(dir, 'sub'));
    expect(sub.cwd).toBe(join(dir, 'sub'));
    expect(await sub.readText('c.txt')).toBe('deep');
  });
});
