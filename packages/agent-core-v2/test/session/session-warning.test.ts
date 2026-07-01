import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IBootstrapService } from '#/app/bootstrap';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { SessionAgentFileSystem, ISessionAgentFileSystem } from '#/session/agentFs';
import { createExecContext, IExecContext } from '#/session/execContext';
import { IAgentProfileService } from '#/agent/profile';
import { ISessionWarningService, SessionWarningService } from '#/session/session';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

function hostEnvironment(homeDir: string): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir,
    ready: Promise.resolve(),
  };
}

function workspaceStub(additionalDirs: readonly string[] = []): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: '/tmp/proj',
    additionalDirs,
    setWorkDir: () => {},
    resolve: (p) => p,
    isWithin: () => true,
    assertAllowed: (p) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function bootstrapStub(homeDir: string): IBootstrapService {
  return { homeDir } as unknown as IBootstrapService;
}

/**
 * Build a Session-scoped host with `SessionWarningService` registered and its
 * collaborators stubbed. `agentLifecycle` defaults to "no live main agent" so
 * the service exercises the on-demand recompute path.
 */
function build(args: {
  workDir: string;
  homeDir: string;
  additionalDirs?: readonly string[];
  agentLifecycle?: IAgentLifecycleService;
}): { host: ScopedTestHost; service: ISessionWarningService } {
  const host = createScopedTestHost([
    stubPair(IBootstrapService, bootstrapStub(args.homeDir)),
    stubPair(IHostEnvironment, hostEnvironment(args.homeDir)),
  ]);
  const ctx = createExecContext(args.workDir);
  const fs: ISessionAgentFileSystem = new SessionAgentFileSystem(ctx);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(IExecContext, ctx),
    stubPair(ISessionAgentFileSystem, fs),
    stubPair(ISessionWorkspaceContext, workspaceStub(args.additionalDirs ?? [])),
    stubPair(
      IAgentLifecycleService,
      args.agentLifecycle ??
        ({
          _serviceBrand: undefined,
          getHandle: () => undefined,
        } as unknown as IAgentLifecycleService),
    ),
  ]);
  return { host, service: session.accessor.get(ISessionWarningService) };
}

describe('SessionWarningService.getSessionWarnings', () => {
  let host: ScopedTestHost | undefined;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionWarningService,
      SessionWarningService,
      InstantiationType.Delayed,
      'sessionWarning',
    );
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-warn-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-warn-work-'));
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns an agents-md-oversized warning when AGENTS.md exceeds the 32 KB budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'x'.repeat(40 * 1024), 'utf-8');
    const built = build({ workDir, homeDir });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'agents-md-oversized',
        severity: 'warning',
        message: expect.stringContaining('exceeds the recommended'),
      }),
    ]);
  });

  it('returns no warnings when AGENTS.md is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const built = build({ workDir, homeDir });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([]);
  });

  it('prefers the main agent cached warning when the agent is live', async () => {
    // No AGENTS.md on disk — the recompute path would yield nothing — but the
    // live main agent reports a cached warning, which must win.
    const cached = 'AGENTS.md total 40 KB exceeds the recommended 32 KB.';
    const profileStub = {
      getAgentsMdWarning: () => cached,
    } as unknown as IAgentProfileService;
    const agentLifecycle = {
      _serviceBrand: undefined,
      getHandle: (id: string) =>
        id === 'main'
          ? { accessor: { get: (token: unknown) => (token === IAgentProfileService ? profileStub : undefined) } }
          : undefined,
    } as unknown as IAgentLifecycleService;

    const built = build({ workDir, homeDir, agentLifecycle });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([
      { code: 'agents-md-oversized', severity: 'warning', message: cached },
    ]);
  });
});
