import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentError, EnvironmentRegistry, environmentEntryInfo, type EnvironmentGenerationSnapshot } from '#/environment/environmentRegistry';
import { fakeEnvironment } from './stubs';

describe('EnvironmentRegistry', () => {
  let registry: EnvironmentRegistry;
  beforeEach(() => {
    registry = new EnvironmentRegistry('workspace');
  });

  it('rejects conflicts', () => {
    registry.register(fakeEnvironment('local', 'one'));
    expect(() => registry.register(fakeEnvironment('local', 'two'))).toThrow(EnvironmentError);
  });

  it('pins leases across replacement', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
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
    const current = fakeEnvironment('local', 'one');
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
    const current = fakeEnvironment('local', 'one');
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
    const first = fakeEnvironment('local', 'one');
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
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' }, ['process']);
    expect(lease.environment).toBe(second);
    expect(second.disposed).toBe(false);
    lease.dispose();
    await registration.remove();
  });

  it('serializes replacement and removal', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
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
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const order: string[] = [];
    for (const name of ['terminal', 'watch', 'mcp', 'background']) {
      lease.track({ dispose: async () => { order.push(name); } });
    }
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    await Promise.resolve();
    expect(order).toEqual(['background']);
    lease.dispose();
    await replacement;
    expect(order).toEqual(['background', 'mcp', 'watch', 'terminal']);
  });

  it('forces bounded disposal exactly once when a lease remains', async () => {
    const registry = new EnvironmentRegistry('workspace', 1);
    const first = fakeEnvironment('local', 'one');
    const originalDispose = first.dispose.bind(first);
    const dispose = vi.fn(originalDispose);
    Object.assign(first, { dispose });
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    await registration.replace(fakeEnvironment('local', 'two'));
    expect(dispose).toHaveBeenCalledTimes(1);
    lease.dispose();
    await registration.remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects queued replacements after registry disposal starts', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    const queued = fakeEnvironment('local', 'three');
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
    const first = fakeEnvironment('local', 'one');
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

    await registration.replace(fakeEnvironment('local', 'two'));
    expect(registry.snapshot().environments[0]).toMatchObject({
      generation: 'two',
      status: 'ready',
    });
  });

  it('does not fallback when a environment is missing', () => {
    registry.register(fakeEnvironment('local', 'one'));
    expect(() => registry.acquire({ workspaceId: 'workspace', environmentId: 'ssh1' })).toThrow('ssh1');
  });

  it('untracks caller-disposed resources so drain disposes each resource exactly once, survivors in reverse order', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
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
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    lease.dispose();
    await replacement;
    expect(order).toEqual(['b', 'c', 'a']);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('rejects track once the generation is draining', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    await Promise.resolve();
    expect(() => lease.track({ dispose: () => {} })).toThrow('draining');
    lease.dispose();
    await replacement;
  });

  it('tracks frozen resources without mutating the original dispose', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const disposed: string[] = [];
    const original = (): void => { disposed.push('dispose'); };
    const frozen = Object.freeze({ dispose: original });

    const tracked = lease.track(frozen);
    expect(frozen.dispose).toBe(original);

    tracked.dispose();
    expect(disposed).toEqual(['dispose']);

    lease.dispose();
    await registration.remove();
    expect(disposed).toEqual(['dispose', 'dispose']);
  });

  it('keeps an independent tracking record per lease when leases share one resource', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const leaseB = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
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

  it('forwards property access and method calls to the tracked resource', () => {
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    class Counter {
      count = 0;
      get doubled(): number { return this.count * 2; }
      increment(step = 1): number { this.count += step; return this.count; }
      dispose(): void {}
    }
    const counter = new Counter();
    const tracked = lease.track(counter);

    expect(tracked.increment(2)).toBe(2);
    expect(tracked.doubled).toBe(4);
    expect(counter.count).toBe(2);
    expect(tracked).not.toBe(counter);

    tracked.dispose();
    lease.dispose();
  });

  it('drains only the closing session resources and keeps other sessions and untagged resources alive', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const leaseB = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
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
    const localLease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const sshLease = registry.acquire({ workspaceId: 'workspace', environmentId: 'ssh1' });
    const order: string[] = [];
    localLease.track({ dispose: () => { order.push('local-a'); } }, 'session-a');
    sshLease.track({ dispose: () => { order.push('ssh-a'); } }, 'session-a');
    sshLease.track({ dispose: () => { order.push('ssh-b'); } }, 'session-b');

    await registry.drainSession('session-a');
    expect(order).toEqual(['ssh-a', 'local-a']);

    localLease.dispose();
    sshLease.dispose();
  });

  it('drains every session resource when the generation drains', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const leaseA = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const leaseB = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const order: string[] = [];
    leaseA.track({ dispose: () => { order.push('a'); } }, 'session-a');
    leaseB.track({ dispose: () => { order.push('b'); } }, 'session-b');

    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    leaseA.dispose();
    leaseB.dispose();
    await replacement;
    expect(order).toEqual(['b', 'a']);
  });

  it('drainSession is a no-op for a session without tracked resources', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const order: string[] = [];
    lease.track({ dispose: () => { order.push('a'); } }, 'session-a');

    await registry.drainSession('session-missing');
    expect(order).toEqual([]);
    lease.dispose();
  });

  it('drainSession continues past a failing resource', async () => {
    registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
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
    const lease = await registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' }, ['process']);
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
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    registry.register(current);
    const failure = new Error('executor process exited before the handshake completed (code 255)');
    current.whenReady = Promise.reject(failure);
    void current.whenReady.catch(() => {});
    current.setStatus('connecting');

    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' })).rejects.toBe(failure);
  });

  it('keeps the immediate unavailable error on a plainly disconnected environment', async () => {
    registry.register(fakeEnvironment('local', 'one', { status: 'disconnected' }));
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' })).rejects.toThrow('disconnected');
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'missing' })).rejects.toThrow('not exist');
  });

  it('treats a pending environment like a disconnected one for acquire, without a failure reason', async () => {
    registry.register(fakeEnvironment('local', 'one', { status: 'pending' }));
    expect(() => registry.acquire({ workspaceId: 'workspace', environmentId: 'local' })).toThrow('environment local is pending');
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace', environmentId: 'local' })).rejects.toThrow('pending');
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

  it('classifies the local environment as local without a declaration entry', () => {
    expect(environmentEntryInfo({ ...snapshot, environmentId: 'local' }, undefined)).toEqual({
      environmentId: 'local',
      type: 'local',
      status: 'ready',
      generation: 'box-one',
      capabilities: ['fs', 'process'],
      defaultCwd: undefined,
      connectError: 'handshake failed',
    });
  });

  it('joins the declaration entry type and defaultCwd for remote entries', () => {
    expect(environmentEntryInfo(snapshot, { type: 'ssh', host: 'box', defaultCwd: '/remote/box' })).toMatchObject({
      type: 'ssh',
      defaultCwd: '/remote/box',
    });
    expect(environmentEntryInfo(snapshot, { type: 'docker', container: 'box' }).type).toBe('docker');
    expect(environmentEntryInfo(snapshot, { command: 'box' }).type).toBe('command');
  });

  it('classifies a non-local environment without a declaration entry as command', () => {
    expect(environmentEntryInfo(snapshot, undefined)).toMatchObject({
      type: 'command',
      defaultCwd: undefined,
    });
  });
});
