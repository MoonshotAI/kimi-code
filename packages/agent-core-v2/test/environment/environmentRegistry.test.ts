import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentError, EnvironmentRegistry, environmentEntryInfo, type EnvironmentGenerationSnapshot } from '#/environment/environmentRegistry';
import { fakeEnvironment } from './stubs';

describe('EnvironmentRegistry', () => {
  let registry: EnvironmentRegistry;
  beforeEach(() => {
    registry = new EnvironmentRegistry();
  });

  it('shares an environment across session bindings while cleaning each session independently', async () => {
    const environments = new EnvironmentRegistry();
    const remote = fakeEnvironment('remote', 'one');
    environments.register(remote);
    const first = environments.acquire({ environmentId: 'remote', cwd: '/repo/first' });
    const second = environments.acquire({ environmentId: 'remote', cwd: '/repo/second' });
    const closed = vi.fn();
    const active = vi.fn();
    first.track({ dispose: closed }, 'first-session');
    second.track({ dispose: active }, 'second-session');
    await environments.drainSession('first-session');
    expect(first.environment).toBe(second.environment);
    expect(closed).toHaveBeenCalledOnce();
    expect(active).not.toHaveBeenCalled();
    expect(environments.current('remote')?.status).toBe('ready');
    first.dispose();
    second.dispose();
    await environments.dispose();
    expect(active).toHaveBeenCalledOnce();
  });

  it('rejects conflicts', () => {
    registry.register(fakeEnvironment('local', 'one'));
    expect(() => registry.register(fakeEnvironment('local', 'two'))).toThrow(EnvironmentError);
  });

  it('replaces the current environment without waiting on held leases', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
    const registration = registry.register(first);
    const lease = registry.acquire({ environmentId: 'local' }, ['fs']);
    await registration.replace(second);
    expect(lease.environment).toBe(first);
    expect(first.disposed).toBe(true);
    expect(registry.acquire({ environmentId: 'local' }).environment).toBe(second);
    lease.dispose();
  });

  it('publishes status and reconnects the same generation', () => {
    const current = fakeEnvironment('local', 'one');
    const statuses: string[] = [];
    registry.onDidChange((change) => {
      if (change.status !== undefined) statuses.push(change.status);
    });
    registry.register(current);
    current.setStatus('disconnected');
    expect(() => registry.acquire({ environmentId: 'local' })).toThrow('disconnected');
    current.setStatus('ready');
    const lease = registry.acquire({ environmentId: 'local' });
    expect(lease.environment).toBe(current);
    expect(lease.environment.identity.generation).toBe('one');
    lease.dispose();
    expect(statuses).toEqual(['ready', 'disconnected', 'ready']);
  });

  it('keeps the current generation when replacement preparation fails', async () => {
    const first = fakeEnvironment('local', 'one');
    const invalid = new FakeEnvironment(
      { environmentId: 'local', generation: 'two' },
      { capabilities: ['fs'] },
    );
    const registration = registry.register(first);
    await expect(registration.replace(invalid)).rejects.toThrow('without an implementation');
    expect(invalid.disposed).toBe(true);
    expect(registry.current('local')).toBe(first);
  });

  it('keeps a published replacement current when previous generation cleanup fails', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
    Object.assign(first, {
      dispose: vi.fn(async () => {
        first.disposed = true;
        throw new Error('old environment cleanup failed');
      }),
    });
    const registration = registry.register(first);

    await expect(registration.replace(second)).rejects.toThrow('old environment cleanup failed');

    expect(registry.current('local')).toBe(second);
    const lease = registry.acquire({ environmentId: 'local' }, ['process']);
    expect(lease.environment).toBe(second);
    expect(second.disposed).toBe(false);
    lease.dispose();
    await registration.remove();
  });

  it('replaces then removes', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
    const registration = registry.register(first);
    await registration.replace(second);
    expect(registry.current('local')).toBe(second);
    expect(first.disposed).toBe(true);
    await registration.remove();
    expect(registry.current('local')).toBeUndefined();
    expect(second.disposed).toBe(true);
  });

  it('closes tracked resources in reverse order when the environment is replaced', async () => {
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    const lease = registry.acquire({ environmentId: 'local' });
    const order: string[] = [];
    for (const name of ['terminal', 'watch', 'mcp', 'background']) {
      lease.track({ dispose: async () => { order.push(name); } });
    }
    await registration.replace(fakeEnvironment('local', 'two'));
    expect(order).toEqual(['background', 'mcp', 'watch', 'terminal']);
    lease.dispose();
  });

  it('disposes a replaced environment even when a lease remains', async () => {
    const first = fakeEnvironment('local', 'one');
    const originalDispose = first.dispose.bind(first);
    const dispose = vi.fn(originalDispose);
    Object.assign(first, { dispose });
    const registration = registry.register(first);
    const lease = registry.acquire({ environmentId: 'local' });
    await registration.replace(fakeEnvironment('local', 'two'));
    expect(dispose).toHaveBeenCalledTimes(1);
    lease.dispose();
    await registration.remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects replacement after the registry is disposed', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    await registry.dispose();
    const queued = fakeEnvironment('local', 'three');
    await expect(registration.replace(queued)).rejects.toThrow('disposing');
    expect(queued.disposed).toBe(true);
    expect(registry.current('local')).toBeUndefined();
  });

  it('snapshots only the current generation and its live status', async () => {
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);

    expect(registry.snapshot()).toEqual({
      environments: [{
        environmentId: 'local',
        generation: 'one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      }],
    });

    first.setStatus('disconnected');
    expect(registry.snapshot().environments[0]?.status).toBe('disconnected');

    await registration.replace(fakeEnvironment('local', 'two'));
    expect(registry.snapshot().environments[0]).toMatchObject({
      generation: 'two',
      status: 'ready',
    });
  });

  it('does not fallback when a environment is missing', () => {
    registry.register(fakeEnvironment('local', 'one'));
    expect(() => registry.acquire({ environmentId: 'ssh1' })).toThrow('ssh1');
  });

  it('untracks caller-disposed resources so drain disposes each resource exactly once, survivors in reverse order', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ environmentId: 'local' });
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
    await registration.replace(fakeEnvironment('local', 'two'));
    lease.dispose();
    expect(order).toEqual(['b', 'c', 'a']);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('rejects track once the environment has been replaced', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ environmentId: 'local' });
    await registration.replace(fakeEnvironment('local', 'two'));
    expect(() => lease.track({ dispose: () => {} })).toThrow('unavailable');
    lease.dispose();
  });

  it('keeps an independent tracking record per lease when leases share one resource', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const disposed: string[] = [];
    const shared = { dispose: () => { disposed.push('dispose'); } };
    const trackedA = leaseA.track(shared, 'session-a');
    const trackedB = leaseB.track(shared, 'session-b');

    await registry.drainSession('session-a');
    expect(disposed).toEqual(['dispose']);

    trackedB.dispose();
    expect(disposed).toEqual(['dispose', 'dispose']);

    trackedA.dispose();
    expect(disposed).toEqual(['dispose', 'dispose']);

    leaseA.dispose();
    leaseB.dispose();
  });

  it('drains only the closing session resources and keeps other sessions and untagged resources alive', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const order: string[] = [];
    const counts = new Map<string, number>();
    const resource = (name: string) => ({
      dispose: () => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        order.push(name);
      },
    });
    leaseA.track(resource('terminal-a'), 'session-a');
    leaseA.track(resource('background-a'), 'session-a');
    leaseB.track(resource('terminal-b'), 'session-b');
    leaseA.track(resource('shared-mcp'));

    await registry.drainSession('session-a');
    expect(order).toEqual(['background-a', 'terminal-a']);

    leaseA.dispose();
    leaseB.dispose();
    await registration.remove();
    expect(order).toEqual(['background-a', 'terminal-a', 'shared-mcp', 'terminal-b']);
    for (const name of ['terminal-a', 'background-a', 'terminal-b', 'shared-mcp']) {
      expect(counts.get(name)).toBe(1);
    }
  });

  it('drains a session resources across every environment in the workspace', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    registry.register(fakeEnvironment('ssh1', 'one'));
    const localLease = registry.acquire({ environmentId: 'local' });
    const sshLease = registry.acquire({ environmentId: 'ssh1' });
    const order: string[] = [];
    localLease.track({ dispose: () => { order.push('local-a'); } }, 'session-a');
    sshLease.track({ dispose: () => { order.push('ssh-a'); } }, 'session-a');
    sshLease.track({ dispose: () => { order.push('ssh-b'); } }, 'session-b');

    await registry.drainSession('session-a');
    expect(order).toEqual(['ssh-a', 'local-a']);

    localLease.dispose();
    sshLease.dispose();
  });

  it('closes every tracked resource when the environment is replaced', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ environmentId: 'local' });
    const leaseB = registry.acquire({ environmentId: 'local' });
    const order: string[] = [];
    leaseA.track({ dispose: () => { order.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { order.push('b'); } }, 'session-b');

    await registration.replace(fakeEnvironment('local', 'two'));
    leaseA.dispose();
    leaseB.dispose();
    expect(order).toEqual(['b', 'a']);
  });

  it('drainSession continues past a failing resource', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ environmentId: 'local' });
    const order: string[] = [];
    lease.track({ dispose: () => { order.push('first'); } }, 'session-a');
    lease.track({
      dispose: () => {
        order.push('boom');
        throw new Error('kill failed');
      },
    }, 'session-a');
    lease.track({ dispose: () => { order.push('survivor'); } }, 'session-b');

    await registry.drainSession('session-a');
    expect(order).toEqual(['boom', 'first']);
    lease.dispose();
  });

  it('acquires a ready environment through acquireWhenReady without waiting', async () => {
    const current = fakeEnvironment('local', 'one');
    current.whenReady = new Promise<void>(() => {});
    registry.register(current);
    const lease = await registry.acquireWhenReady({ environmentId: 'local' }, ['process']);
    expect(lease.environment).toBe(current);
    lease.dispose();
  });

  it('awaits an in-flight readiness signal instead of erroring, then acquires once ready', async () => {
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    registry.register(current);
    let releaseReady!: () => void;
    current.whenReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    current.setStatus('connecting');

    let settled = false;
    const pending = registry.acquireWhenReady({ environmentId: 'local' }, ['fs']).then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => registry.acquire({ environmentId: 'local' })).toThrow('connecting');

    current.setStatus('ready');
    current.whenReady = undefined;
    releaseReady();
    const lease = await pending;
    expect(settled).toBe(true);
    expect(lease.environment).toBe(current);
    lease.dispose();
  });

  it('rejects acquireWhenReady with the connect failure reason when the readiness signal rejects', async () => {
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    registry.register(current);
    const failure = new Error('executor process exited before the handshake completed (code 255)');
    current.whenReady = Promise.reject(failure);
    void current.whenReady.catch(() => {});
    current.setStatus('connecting');

    await expect(registry.acquireWhenReady({ environmentId: 'local' })).rejects.toBe(failure);
  });

  it('treats a pending environment like a disconnected one for acquire, without a failure reason', async () => {
    registry.register(fakeEnvironment('local', 'one', { status: 'pending' }));
    expect(() => registry.acquire({ environmentId: 'local' })).toThrow('environment local is pending');
    await expect(registry.acquireWhenReady({ environmentId: 'local' })).rejects.toThrow('pending');
    expect(registry.snapshot().environments[0]).toMatchObject({
      environmentId: 'local',
      status: 'pending',
      connectError: undefined,
    });
  });

  it('appends the recorded connect error first line to the unavailable error', async () => {
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    current.connectError = 'initialize timed out after 10000ms; executor stderr: Password:\nsecond line stays out';
    registry.register(current);

    const binding = { environmentId: 'local' };
    const attempt = (): unknown => registry.acquire(binding);
    expect(attempt).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(attempt).toThrow('environment local is disconnected: initialize timed out after 10000ms; executor stderr: Password:');
    expect(attempt).not.toThrow('second line');
    await expect(registry.acquireWhenReady(binding)).rejects.toThrow('executor stderr: Password:');
  });

  it('includes the recorded connect error in the generation snapshot', () => {
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    current.connectError = 'ssh: connect failed (code 255)';
    registry.register(current);
    expect(registry.snapshot().environments[0]).toMatchObject({
      environmentId: 'local',
      status: 'disconnected',
      connectError: 'ssh: connect failed (code 255)',
    });
  });
});

describe('environmentEntryInfo', () => {
  const snapshot: EnvironmentGenerationSnapshot = {
    environmentId: 'box',
    generation: 'box-one',
    status: 'ready',
    capabilities: ['fs', 'process'],
    connectError: 'handshake failed',
  };

  it('classifies entries from the snapshot and declaration entry', () => {
    expect(environmentEntryInfo({ ...snapshot, environmentId: 'local' }, undefined)).toEqual({
      environmentId: 'local',
      type: 'local',
      status: 'ready',
      generation: 'box-one',
      capabilities: ['fs', 'process'],
      defaultCwd: undefined,
      connectError: 'handshake failed',
    });
    expect(environmentEntryInfo(snapshot, { type: 'ssh', host: 'box', defaultCwd: '/remote/box' })).toMatchObject({
      type: 'ssh',
      defaultCwd: '/remote/box',
    });
    expect(environmentEntryInfo(snapshot, { type: 'docker', container: 'box' }).type).toBe('docker');
    expect(environmentEntryInfo(snapshot, { command: 'box' }).type).toBe('command');
    expect(environmentEntryInfo(snapshot, undefined)).toMatchObject({
      type: 'command',
      defaultCwd: undefined,
    });
  });
});
