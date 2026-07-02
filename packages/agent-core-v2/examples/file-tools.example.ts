/**
 * Example 13 — the `fileTools` slice across all three scope tiers.
 *
 * Concept taught: a real feature is a *vertical slice* — one Agent-scope
 * service (`IAgentFileToolsService`) injecting a same-tier peer
 * (`IAgentToolRegistryService`), four Session-scope ancestors
 * (`ISessionAgentFileSystem`, `ISessionFsService`, `ISessionProcessRunner`,
 * `ISessionWorkspaceContext`), and two App-scope ancestors (`IHostEnvironment`,
 * `ITelemetryService`). This is the "short-lived injects long-lived" rule made
 * concrete.
 *
 * This is the smallest real 3-tier slice in the dep-graph: 8 registered
 * services and a single external boundary token (`IExecContext`, from kaos).
 * We stub the five leaf dependencies with minimal fakes instead of
 * constructing their real implementations, so the example needs no kaos and
 * stays focused on the wiring. `IAgentFileToolsService` is registered
 * `Eager` because it is a marker interface — a delayed proxy would never be
 * woken by a method call, so its constructor (which registers the tools) must
 * run eagerly.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/file-tools.example.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

import {
  AgentFileToolsService,
  IAgentFileToolsService,
} from '#/agent/fileTools';
import {
  AgentToolRegistryService,
  IAgentToolRegistryService,
} from '#/agent/toolRegistry';

import { IHostEnvironment } from '#/app/hostEnvironment';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry';
import {
  ISessionAgentFileSystem,
  ISessionFsService,
} from '#/session/agentFs';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

// Minimal leaf fakes — mirror test/fileTools/fileToolsService.test.ts. The
// real tool constructors only read these surfaces during construction.
const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home',
  ready: Promise.resolve(),
};
const fakeFs = { cwd: '/workspace' } as unknown as ISessionAgentFileSystem;
const fakeFsService = {} as unknown as ISessionFsService;
const fakeRunner = {
  _serviceBrand: undefined,
  exec: vi.fn(),
} as unknown as ISessionProcessRunner;
const fakeWorkspace = {
  workDir: '/workspace',
  additionalDirs: [],
} as unknown as ISessionWorkspaceContext;

describe('example 13 — file-tools slice (App + Session + Agent)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    // Register only the two real Agent-scope services of the slice. Their
    // Session/App ancestors are supplied as stubs below.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentToolRegistryService,
      AgentToolRegistryService,
    );
    // Eager: `IAgentFileToolsService` is a marker interface (no methods), so a
    // delayed proxy would never be "woken" by a method call. Eager makes
    // `accessor.get(...)` run the constructor — which registers the tools —
    // immediately.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentFileToolsService,
      AgentFileToolsService,
      InstantiationType.Eager,
    );
  });

  it('registers the five built-in file tools through the scope tree', () => {
    const host = createScopedTestHost([
      stubPair(IHostEnvironment, fakeEnv),
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionAgentFileSystem, fakeFs),
      stubPair(ISessionFsService, fakeFsService),
      stubPair(ISessionProcessRunner, fakeRunner),
      stubPair(ISessionWorkspaceContext, fakeWorkspace),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    // Constructing the Agent-scope service wires Read/Write/Edit/Grep/Glob
    // into the same Agent-scope tool registry.
    agent.accessor.get(IAgentFileToolsService);

    const tools = agent.accessor.get(IAgentToolRegistryService).list();
    expect(tools.map((t) => t.name)).toEqual([
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);

    host.dispose();
  });

  it('resolves the same Agent-scope instance on repeated access (singleton per scope)', () => {
    const host = createScopedTestHost([
      stubPair(IHostEnvironment, fakeEnv),
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionAgentFileSystem, fakeFs),
      stubPair(ISessionFsService, fakeFsService),
      stubPair(ISessionProcessRunner, fakeRunner),
      stubPair(ISessionWorkspaceContext, fakeWorkspace),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const a = agent.accessor.get(IAgentFileToolsService);
    const b = agent.accessor.get(IAgentFileToolsService);
    expect(a).toBe(b);

    host.dispose();
  });
});
