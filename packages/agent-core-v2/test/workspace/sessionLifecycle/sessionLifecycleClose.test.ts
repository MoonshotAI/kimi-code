import { describe, expect, it } from 'vitest';

import type { IEnvironmentService } from '#/app/environment/environment';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { InMemorySessionLockService } from '#/persistence/backends/memory/sessionLockService';
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
    new InMemorySessionLockService(),
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
    environments as unknown as IEnvironmentService,
    undefined as never,
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
  it.each(['close', 'archive'] as const)('%s drains only the target session environment resources', async (operation) => {
    const registry = new EnvironmentRegistry();
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const killed: string[] = [];
    leaseA.track({ dispose: () => { killed.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { killed.push('b'); } }, 'session-b');

    const service = closeHarness(registry);
    seedSession(service, 'session-a');
    await service[operation]('session-a');

    expect(killed).toEqual(['a']);
    leaseA.dispose();
    leaseB.dispose();
  });
});
