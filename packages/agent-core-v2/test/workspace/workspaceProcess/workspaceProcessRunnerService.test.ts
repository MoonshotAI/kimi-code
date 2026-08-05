import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { WorkspaceProcessRunnerService } from '#/workspace/workspaceProcess/workspaceProcessRunnerService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('WorkspaceProcessRunnerService', () => {
  let dir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IHostProcessService,
      HostProcessService,
      ScopeActivation.OnDemand,
      'hostProcess',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      ISessionProcessRunner,
      WorkspaceProcessRunnerService,
      ScopeActivation.OnDemand,
      'workspaceProcess',
    );
    dir = await mkdtemp(join(tmpdir(), 'procrunner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeRunner(): Promise<ISessionProcessRunner> {
    const host = createScopedTestHost();
    const workspace = host.child(LifecycleScope.Workspace, 'w', [
      stubPair(IWorkspaceContext, {
        _serviceBrand: undefined,
        workspaceId: 'w',
        cwd: dir,
        source: 'local',
        meta: { id: 'w', root: dir, name: 'proj', createdAt: 1, lastOpenedAt: 1 },
        persistenceScope: 'sessions/w',
        osBackendId: 'local',
        persistenceBackendId: 'local',
      } satisfies IWorkspaceContext),
    ]);
    return workspace.accessor.get(ISessionProcessRunner);
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
