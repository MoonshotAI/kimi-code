import { describe, expect, it } from 'vitest';

import type { ISessionScopeHandle } from '#/_base/di/scope';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

import { fakeEnvironment } from '../../environment/stubs';

function closeHarness(environments: EnvironmentRegistry): SessionLifecycleService {
  return new SessionLifecycleService(
    undefined as never,
    { workspaceId: 'workspace' } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { drain: async () => {} } as never,
    { drainRetirements: async () => {} } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { publish: () => {} } as never,
    { withContext: () => ({ track2: () => {} }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    environments,
  );
}

function seedSession(service: SessionLifecycleService, sessionId: string): void {
  const handle = {
    id: sessionId,
    kind: 'session',
    accessor: {
      get: () => ({ list: () => [], setArchived: async () => {} }),
    },
    dispose: () => {},
  } as unknown as ISessionScopeHandle;
  (service as unknown as { sessions: Map<string, ISessionScopeHandle> }).sessions.set(sessionId, handle);
}

describe('SessionLifecycleService environment cleanup', () => {
  it('close drains only the closing session environment resources', async () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const leaseB = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const killed: string[] = [];
    leaseA.track({ dispose: () => { killed.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { killed.push('b'); } }, 'session-b');

    const service = closeHarness(registry);
    seedSession(service, 'session-a');
    await service.close('session-a');

    expect(killed).toEqual(['a']);
    leaseA.dispose();
    leaseB.dispose();
  });

  it('archive drains the archived session environment resources', async () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const leaseB = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const killed: string[] = [];
    leaseA.track({ dispose: () => { killed.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { killed.push('b'); } }, 'session-b');

    const service = closeHarness(registry);
    seedSession(service, 'session-a');
    await service.archive('session-a');

    expect(killed).toEqual(['a']);
    leaseA.dispose();
    leaseB.dispose();
  });

  it('close without a live session leaves environment resources untouched', async () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const killed: string[] = [];
    lease.track({ dispose: () => { killed.push('a'); } }, 'session-a');

    const service = closeHarness(registry);
    await service.close('session-a');

    expect(killed).toEqual([]);
    lease.dispose();
  });
});
