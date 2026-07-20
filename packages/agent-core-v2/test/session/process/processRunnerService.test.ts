import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { SessionProcessRunner } from '#/session/process/processRunnerService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('SessionProcessRunner', () => {
  let dir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IHostProcessService,
      HostProcessService,
      InstantiationType.Delayed,
      'hostProcess',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionProcessRunner,
      SessionProcessRunner,
      InstantiationType.Delayed,
      'process',
    );
    dir = await mkdtemp(join(tmpdir(), 'procrunner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeRunner(): Promise<ISessionProcessRunner> {
    const host = createScopedTestHost();
    const session = host.child(
      LifecycleScope.Session,
      's',
      [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 's',
            workspaceId: 'w',
            sessionDir: dir,
            sessionScope: 'sessions/w/s',
            cwd: dir,
          }),
        ),
      ],
    );
    return session.accessor.get(ISessionProcessRunner);
  }

  it('exec runs a command and captures stdout + exit code', async () => {
    const runner = await makeRunner();
    const proc = await runner.exec(['node', '-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('exec overlays per-call env', async () => {
    const runner = await makeRunner();
    const proc = await runner.exec(
      ['node', '-e', 'process.stdout.write(process.env.FOO ?? "")'],
      { env: { FOO: 'bar' } },
    );
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });
});
