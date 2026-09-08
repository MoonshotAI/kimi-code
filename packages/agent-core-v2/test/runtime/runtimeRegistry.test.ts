import { describe, expect, it, vi } from 'vitest';

import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeError, RuntimeRegistry } from '#/runtime/runtimeRegistry';

function runtime(generation: string, status: 'ready' | 'disconnected' = 'ready'): FakeRuntime {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation },
      { status, capabilities: ['fs', 'process'] },
    ),
    { fs: {} as never, process: {} as never },
  );
}

describe('RuntimeRegistry', () => {
  it('rejects conflicts', () => {
    const registry = new RuntimeRegistry('workspace');
    registry.register(runtime('one'));
    expect(() => registry.register(runtime('two'))).toThrow(RuntimeError);
  });

  it('pins leases across replacement', async () => {
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const second = runtime('two');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' }, ['fs']);
    const replacement = registration.replace(second);
    await Promise.resolve();
    expect(lease.runtime).toBe(first);
    expect(registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' }).runtime).toBe(second);
    expect(first.disposed).toBe(false);
    lease.dispose();
    await replacement;
    expect(first.disposed).toBe(true);
  });

  it('publishes status and reconnects the same generation', () => {
    const registry = new RuntimeRegistry('workspace');
    const current = runtime('one');
    const statuses: string[] = [];
    registry.onDidChange((change) => {
      if (change.status !== undefined) statuses.push(change.status);
    });
    registry.register(current);
    current.setStatus('disconnected');
    expect(() => registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' })).toThrow('disconnected');
    current.setStatus('ready');
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    expect(lease.runtime).toBe(current);
    expect(lease.runtime.identity.generation).toBe('one');
    lease.dispose();
    expect(statuses).toEqual(['ready', 'disconnected', 'ready']);
  });

  it('allows degraded generations only when every required capability remains available', () => {
    const registry = new RuntimeRegistry('workspace');
    const current = runtime('one');
    registry.register(current);
    current.setStatus('degraded');

    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' }, ['fs', 'process']);
    expect(lease.runtime).toBe(current);
    lease.dispose();
    expect(() => registry.acquire(
      { workspaceId: 'workspace', runtimeId: 'local' },
      ['terminal'],
    )).toThrowError(expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }));
  });

  it('keeps the current generation when replacement preparation fails', async () => {
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const invalid = new FakeRuntime(
      { workspaceId: 'other', runtimeId: 'local', generation: 'two' },
      { capabilities: ['fs'] },
    );
    const registration = registry.register(first);
    await expect(registration.replace(invalid)).rejects.toThrow('other');
    expect(invalid.disposed).toBe(true);
    expect(registry.current('local')).toBe(first);
  });

  it('keeps a published replacement current when previous generation cleanup fails', async () => {
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const second = runtime('two');
    Object.assign(first, {
      dispose: vi.fn(async () => {
        first.disposed = true;
        throw new Error('old runtime cleanup failed');
      }),
    });
    const registration = registry.register(first);

    await expect(registration.replace(second)).rejects.toThrow('old runtime cleanup failed');

    expect(registry.current('local')).toBe(second);
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' }, ['process']);
    expect(lease.runtime).toBe(second);
    expect(second.disposed).toBe(false);
    lease.dispose();
    await registration.remove();
  });

  it('serializes replacement and removal', async () => {
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const second = runtime('two');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
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
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    const order: string[] = [];
    for (const name of ['terminal', 'watch', 'mcp', 'background']) {
      lease.track({ dispose: async () => { order.push(name); } });
    }
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    expect(order).toEqual(['background']);
    lease.dispose();
    await replacement;
    expect(order).toEqual(['background', 'mcp', 'watch', 'terminal']);
  });

  it('forces bounded disposal exactly once when a lease remains', async () => {
    const registry = new RuntimeRegistry('workspace', 1);
    const first = runtime('one');
    const originalDispose = first.dispose.bind(first);
    const dispose = vi.fn(originalDispose);
    Object.assign(first, { dispose });
    const registration = registry.register(first);
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    await registration.replace(runtime('two'));
    expect(dispose).toHaveBeenCalledTimes(1);
    lease.dispose();
    await registration.remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects queued replacements after registry disposal starts', async () => {
    const registry = new RuntimeRegistry('workspace');
    const registration = registry.register(runtime('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    const replacement = registration.replace(runtime('two'));
    const queued = runtime('three');
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
    const registry = new RuntimeRegistry('workspace');
    const first = runtime('one');
    const registration = registry.register(first);

    expect(registry.snapshot()).toEqual({
      workspaceId: 'workspace',
      runtimes: [{
        runtimeId: 'local',
        generation: 'one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      }],
    });

    first.setStatus('disconnected');
    expect(registry.snapshot().runtimes[0]?.status).toBe('disconnected');

    await registration.replace(runtime('two'));
    expect(registry.snapshot().runtimes[0]).toMatchObject({
      generation: 'two',
      status: 'ready',
    });
  });

  it('does not fallback when a runtime is missing', () => {
    const registry = new RuntimeRegistry('workspace');
    registry.register(runtime('one'));
    expect(() => registry.acquire({ workspaceId: 'workspace', runtimeId: 'ssh1' })).toThrow('ssh1');
  });

  it('untracks caller-disposed resources so drain disposes each resource exactly once, survivors in reverse order', async () => {
    const registry = new RuntimeRegistry('workspace');
    const registration = registry.register(runtime('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
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
    const replacement = registration.replace(runtime('two'));
    lease.dispose();
    await replacement;
    expect(order).toEqual(['b', 'c', 'a']);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('rejects track once the generation is draining', async () => {
    const registry = new RuntimeRegistry('workspace');
    const registration = registry.register(runtime('one'));
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    expect(() => lease.track({ dispose: () => {} })).toThrow('draining');
    lease.dispose();
    await replacement;
  });
});
