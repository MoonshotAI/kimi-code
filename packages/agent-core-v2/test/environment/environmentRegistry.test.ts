import { describe, expect, it, vi } from 'vitest';

import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentError, EnvironmentRegistry } from '#/environment/environmentRegistry';

function environment(generation: string, status: 'ready' | 'disconnected' = 'ready'): FakeEnvironment {
  return Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'local', generation },
      { status, capabilities: ['fs', 'process'] },
    ),
    { fs: {} as never, process: {} as never },
  );
}

describe('EnvironmentRegistry', () => {
  it('rejects conflicts', () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(environment('one'));
    expect(() => registry.register(environment('two'))).toThrow(EnvironmentError);
  });

  it('pins leases across replacement', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const second = environment('two');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' }, ['fs']);
    const replacement = registration.replace(second);
    await Promise.resolve();
    expect(lease.environment).toBe(first);
    expect(registry.acquire({ workspaceId: 'workspace', environmentId: 'local' }).environment).toBe(second);
    expect(first.disposed).toBe(false);
    lease.dispose();
    await replacement;
    expect(first.disposed).toBe(true);
  });

  it('publishes status and reconnects the same generation', () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one');
    const statuses: string[] = [];
    registry.onDidChange((change) => {
      if (change.status !== undefined) statuses.push(change.status);
    });
    registry.register(current);
    current.setStatus('disconnected');
    expect(() => registry.acquire({ workspaceId: 'workspace', environmentId: 'local' })).toThrow('disconnected');
    current.setStatus('ready');
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    expect(lease.environment).toBe(current);
    expect(lease.environment.identity.generation).toBe('one');
    lease.dispose();
    expect(statuses).toEqual(['ready', 'disconnected', 'ready']);
  });

  it('allows degraded generations only when every required capability remains available', () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one');
    registry.register(current);
    current.setStatus('degraded');

    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' }, ['fs', 'process']);
    expect(lease.environment).toBe(current);
    lease.dispose();
    expect(() => registry.acquire(
      { workspaceId: 'workspace', environmentId: 'local' },
      ['terminal'],
    )).toThrowError(expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }));
  });

  it('keeps the current generation when replacement preparation fails', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const invalid = new FakeEnvironment(
      { workspaceId: 'other', environmentId: 'local', generation: 'two' },
      { capabilities: ['fs'] },
    );
    const registration = registry.register(first);
    await expect(registration.replace(invalid)).rejects.toThrow('other');
    expect(invalid.disposed).toBe(true);
    expect(registry.current('local')).toBe(first);
  });

  it('keeps a published replacement current when previous generation cleanup fails', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const second = environment('two');
    Object.assign(first, {
      dispose: vi.fn(async () => {
        first.disposed = true;
        throw new Error('old environment cleanup failed');
      }),
    });
    const registration = registry.register(first);

    await expect(registration.replace(second)).rejects.toThrow('old environment cleanup failed');

    expect(registry.current('local')).toBe(second);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' }, ['process']);
    expect(lease.environment).toBe(second);
    expect(second.disposed).toBe(false);
    lease.dispose();
    await registration.remove();
  });

  it('serializes replacement and removal', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const second = environment('two');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const replacement = registration.replace(second);
    const removal = registration.remove();
    await Promise.resolve();
    expect(registry.current('local')).toBe(second);
    lease.dispose();
    await Promise.all([replacement, removal]);
    expect(registry.current('local')).toBeUndefined();
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
  });

  it('actively closes terminal, watch, MCP, and background resources in reverse order', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const order: string[] = [];
    for (const name of ['terminal', 'watch', 'mcp', 'background']) {
      lease.track({ dispose: async () => { order.push(name); } });
    }
    const replacement = registration.replace(environment('two'));
    await Promise.resolve();
    expect(order).toEqual(['background']);
    lease.dispose();
    await replacement;
    expect(order).toEqual(['background', 'mcp', 'watch', 'terminal']);
  });

  it('forces bounded disposal exactly once when a lease remains', async () => {
    const registry = new EnvironmentRegistry('workspace', 1);
    const first = environment('one');
    const originalDispose = first.dispose.bind(first);
    const dispose = vi.fn(originalDispose);
    Object.assign(first, { dispose });
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    await registration.replace(environment('two'));
    expect(dispose).toHaveBeenCalledTimes(1);
    lease.dispose();
    await registration.remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects queued replacements after registry disposal starts', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const registration = registry.register(environment('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const replacement = registration.replace(environment('two'));
    const queued = environment('three');
    const queuedReplacement = registration.replace(queued);
    await Promise.resolve();
    const disposal = registry.dispose();
    lease.dispose();
    await replacement;
    await expect(queuedReplacement).rejects.toThrow('disposed');
    await disposal;
    expect(queued.disposed).toBe(true);
    expect(registry.current('local')).toBeUndefined();
  });

  it('snapshots only the current generation and its live status', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const first = environment('one');
    const registration = registry.register(first);

    expect(registry.snapshot()).toEqual({
      workspaceId: 'workspace',
      environments: [{
        environmentId: 'local',
        generation: 'one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      }],
    });

    first.setStatus('disconnected');
    expect(registry.snapshot().environments[0]?.status).toBe('disconnected');

    await registration.replace(environment('two'));
    expect(registry.snapshot().environments[0]).toMatchObject({
      generation: 'two',
      status: 'ready',
    });
  });

  it('does not fallback when a environment is missing', () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(environment('one'));
    expect(() => registry.acquire({ workspaceId: 'workspace', environmentId: 'ssh1' })).toThrow('ssh1');
  });

  it('untracks caller-disposed resources so drain disposes each resource exactly once, survivors in reverse order', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const registration = registry.register(environment('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const order: string[] = [];
    const counts = new Map<string, number>();
    const resource = (name: string) => ({
      dispose: () => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        order.push(name);
      },
    });
    const a = lease.track(resource('a'));
    const b = lease.track(resource('b'));
    const c = lease.track(resource('c'));
    b.dispose();
    b.dispose();
    const replacement = registration.replace(environment('two'));
    lease.dispose();
    await replacement;
    expect(order).toEqual(['b', 'c', 'a']);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('rejects track once the generation is draining', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const registration = registry.register(environment('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const replacement = registration.replace(environment('two'));
    await Promise.resolve();
    expect(() => lease.track({ dispose: () => {} })).toThrow('draining');
    lease.dispose();
    await replacement;
  });

  it('acquires a ready environment through acquireWhenReady without waiting', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one');
    registry.register(current);
    const lease = await registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' }, ['process']);
    expect(lease.environment).toBe(current);
    lease.dispose();
  });

  it('awaits an in-flight readiness signal instead of erroring, then acquires once ready', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one', 'disconnected');
    registry.register(current);
    let releaseReady!: () => void;
    current.whenReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    current.setStatus('connecting');

    let settled = false;
    const pending = registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' }, ['fs']).then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => registry.acquire({ workspaceId: 'workspace', environmentId: 'local' })).toThrow('connecting');

    current.setStatus('ready');
    current.whenReady = undefined;
    releaseReady();
    const lease = await pending;
    expect(settled).toBe(true);
    expect(lease.environment).toBe(current);
    lease.dispose();
  });

  it('rejects acquireWhenReady with the connect failure reason when the readiness signal rejects', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one', 'disconnected');
    registry.register(current);
    const failure = new Error('executor process exited before the handshake completed (code 255)');
    current.whenReady = Promise.reject(failure);
    void current.whenReady.catch(() => {});
    current.setStatus('connecting');

    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' })).rejects.toBe(failure);
  });

  it('keeps the immediate unavailable error on a plainly disconnected environment', async () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(environment('one', 'disconnected'));
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' })).rejects.toThrow('disconnected');
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'missing' })).rejects.toThrow('not exist');
  });

  it('appends the recorded connect error first line to the unavailable error', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one', 'disconnected');
    current.connectError = 'initialize timed out after 10000ms; executor stderr: Password:\nsecond line stays out';
    registry.register(current);

    const binding = { workspaceId: 'workspace', environmentId: 'local' };
    const attempt = (): unknown => registry.acquire(binding);
    expect(attempt).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(attempt).toThrow('environment local is disconnected: initialize timed out after 10000ms; executor stderr: Password:');
    expect(attempt).not.toThrow('second line');
    await expect(registry.acquireWhenReady(binding)).rejects.toThrow('executor stderr: Password:');
  });

  it('includes the recorded connect error in the generation snapshot', () => {
    const registry = new EnvironmentRegistry('workspace');
    const current = environment('one', 'disconnected');
    current.connectError = 'ssh: connect failed (code 255)';
    registry.register(current);
    expect(registry.snapshot().environments[0]).toMatchObject({
      environmentId: 'local',
      status: 'disconnected',
      connectError: 'ssh: connect failed (code 255)',
    });
  });
});
