import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvironmentError, EnvironmentRegistry } from '#/environment/environmentRegistry';
import { fakeEnvironment } from './stubs';

describe('EnvironmentRegistry', () => {
  let registry: EnvironmentRegistry;
  beforeEach(() => {
    registry = new EnvironmentRegistry();
  });

  it('rejects conflicts', () => {
    registry.register(fakeEnvironment('local', 'one'));
    expect(() => registry.register(fakeEnvironment('local', 'two'))).toThrow(EnvironmentError);
  });

  it('removes the current environment without waiting on held leases', async () => {
    const first = fakeEnvironment('local', 'one');
    const second = fakeEnvironment('local', 'two');
    const registration = registry.register(first);
    const lease = registry.acquire({ environmentId: 'local' }, ['fs']);
    await registration.remove();
    registry.register(second);
    expect(lease.environment).toBe(first);
    expect(first.disposed).toBe(true);
    expect(registry.acquire({ environmentId: 'local' }).environment).toBe(second);
    lease.dispose();
  });

  it('drains a removed environment after its lease is released', async () => {
    const first = fakeEnvironment('local', 'one');
    const originalDispose = first.dispose.bind(first);
    const dispose = vi.fn(originalDispose);
    Object.assign(first, { dispose });
    const registration = registry.register(first);
    const lease = registry.acquire({ environmentId: 'local' });
    const removal = registration.remove();
    expect(dispose).not.toHaveBeenCalled();
    lease.dispose();
    await removal;
    expect(dispose).toHaveBeenCalledTimes(1);
    await registration.remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a removed environment after the drain timeout', async () => {
    vi.useFakeTimers();
    try {
      const first = fakeEnvironment('local', 'one');
      const registration = registry.register(first);
      const lease = registry.acquire({ environmentId: 'local' });
      const removal = registration.remove();

      await vi.advanceTimersByTimeAsync(5000);
      await removal;

      expect(first.disposed).toBe(true);
      lease.dispose();
    } finally {
      vi.useRealTimers();
    }
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
    await registration.remove();
    lease.dispose();
    expect(order).toEqual(['b', 'c', 'a']);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('rejects track once the environment has been removed', async () => {
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const lease = registry.acquire({ environmentId: 'local' });
    await registration.remove();
    expect(() => lease.track({ dispose: () => {} })).toThrow('unavailable');
    lease.dispose();
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
});
