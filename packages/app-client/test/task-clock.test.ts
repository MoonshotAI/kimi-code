import { computed, effectScope, getCurrentScope, watchEffect, type EffectScope } from 'vue';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTask, KimiEventConnection } from '@moonshot-ai/app-core/api';
import { useTaskClock as createTaskClock } from '../src/client/useTaskClock';
import { useTaskOutputStream } from '../src/client/useTaskOutputStream';

const scopes: EffectScope[] = [];

function useTaskClock(...args: Parameters<typeof createTaskClock>): ReturnType<typeof createTaskClock> {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => createTaskClock(...args))!;
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function runningRow(): AppTask {
  return {
    id: 'task-9',
    sessionId: 'sess_1',
    kind: 'bash',
    description: 'task',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('useTaskClock', () => {
  it('holds the elapsed-time clock while the document is hidden', async () => {
    vi.useFakeTimers();
    const visibility = { visibilityState: 'visible' as DocumentVisibilityState };
    vi.stubGlobal('document', visibility);
    const clock = useTaskClock(computed(() => [runningRow()]));

    await vi.advanceTimersByTimeAsync(3000);
    const visibleTicks = clock.tick.value;
    expect(visibleTicks).toBe(3);

    visibility.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(5000);
    expect(clock.tick.value).toBe(visibleTicks);

    visibility.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.tick.value).toBe(visibleTicks + 1);
  });
});

describe('useTaskClock explicit disposal without a Vue scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    assert.isUndefined(getCurrentScope());
  });

  it('idempotently stops the clock', async () => {
    const clock = createTaskClock(computed(() => [runningRow()]));
    try {
      expect(vi.getTimerCount()).toBe(1);
      clock.dispose();
      clock.dispose();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(5000);
      expect(clock.tick.value).toBe(0);
    } finally {
      clock.dispose();
    }
  });
});

describe('useTaskOutputStream', () => {
  function setup() {
    const connection = { watchTaskOutput: vi.fn(), unwatchTaskOutput: vi.fn() };
    const stream = useTaskOutputStream({ connection: () => connection as unknown as KimiEventConnection });
    return { connection, stream };
  }

  it('buffers output only for watched tasks and forgets it on unwatch', () => {
    const { connection, stream } = setup();
    stream.receive('sess_1', 'main', 'task-1', 0, 'early');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toBeUndefined();

    stream.watch('sess_1', 'main', 'task-1');
    stream.watch('sess_1', 'main', 'task-1');
    expect(connection.watchTaskOutput).toHaveBeenCalledExactlyOnceWith('sess_1', 'main', 'task-1');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toEqual({ status: 'loading' });
    stream.receive('sess_1', 'main', 'task-1', 0, 'a');
    stream.receive('sess_1', 'main', 'task-1', 1, 'b');
    stream.receive('sess_1', 'agent-1', 'task-1', 0, 'other agent');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toEqual({ status: 'ready', text: 'ab' });
    expect(stream.outputOf('sess_1', 'agent-1', 'task-1')).toBeUndefined();

    stream.unwatch('sess_1', 'main', 'task-1');
    stream.unwatch('sess_1', 'main', 'task-1');
    expect(connection.unwatchTaskOutput).toHaveBeenCalledExactlyOnceWith('sess_1', 'main', 'task-1');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toBeUndefined();
  });

  it('replaces the buffer when a chunk does not continue it', () => {
    const { stream } = setup();
    stream.watch('sess_1', 'main', 'task-1');
    stream.receive('sess_1', 'main', 'task-1', 0, 'before reconnect');
    stream.receive('sess_1', 'main', 'task-1', 4096, 'tail');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toEqual({ status: 'ready', text: 'tail' });
  });

  it('marks a failed watch until the task is watched again', () => {
    const { connection, stream } = setup();
    stream.fail('sess_1', 'main', 'task-1');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toBeUndefined();

    stream.watch('sess_1', 'main', 'task-1');
    stream.fail('sess_1', 'main', 'task-1');
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toEqual({ status: 'failed' });

    stream.unwatch('sess_1', 'main', 'task-1');
    stream.watch('sess_1', 'main', 'task-1');
    expect(connection.watchTaskOutput).toHaveBeenCalledTimes(2);
    expect(stream.outputOf('sess_1', 'main', 'task-1')).toEqual({ status: 'loading' });
  });

  it('notifies readers once per frame however many chunks arrive', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
    const { stream } = setup();
    stream.watch('sess_1', 'main', 'task-1');
    const seen: Array<string | undefined> = [];
    const scope = effectScope();
    scopes.push(scope);
    scope.run(() =>
      watchEffect(() => {
        const output = stream.outputOf('sess_1', 'main', 'task-1');
        seen.push(output?.status === 'ready' ? output.text : output?.status);
      }),
    );

    stream.receive('sess_1', 'main', 'task-1', 0, 'a');
    stream.receive('sess_1', 'main', 'task-1', 1, 'b');
    stream.receive('sess_1', 'main', 'task-1', 2, 'c');
    expect(seen).toEqual(['loading']);

    await vi.advanceTimersByTimeAsync(16);
    expect(seen).toEqual(['loading', 'abc']);
  });
});
