import { describe, expect, it, vi } from 'vitest';
import { LatestFrameScheduler } from '../../src/renderer/screenshot/latest-frame';

function harness<T>(commit: (value: T) => void) {
  let next = 0;
  const callbacks = new Map<number, () => void>();
  const request = vi.fn((callback: () => void) => {
    const handle = ++next;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: number) => { callbacks.delete(handle); });
  const fire = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return { scheduler: new LatestFrameScheduler(commit, request, cancel), request, cancel, fire };
}

describe('latest frame scheduler', () => {
  it('commits only the latest value once per display frame', () => {
    const commit = vi.fn();
    const { scheduler, request, fire } = harness(commit);
    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.schedule(3);
    expect(request).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    fire();
    expect(commit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('flushes the final value before a terminal pointer event', () => {
    const commit = vi.fn();
    const { scheduler, cancel, fire } = harness(commit);
    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.flushPending();
    expect(cancel).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledExactlyOnceWith(2);
    fire();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('drops stale work on cancellation', () => {
    const commit = vi.fn();
    const { scheduler, fire } = harness(commit);
    scheduler.schedule(1);
    scheduler.cancel();
    fire();
    expect(commit).not.toHaveBeenCalled();
  });

  it('allows a commit to schedule the following frame', () => {
    const seen: number[] = [];
    let scheduler!: LatestFrameScheduler<number>;
    const result = harness<number>((value) => {
      seen.push(value);
      if (value === 1) scheduler.schedule(2);
    });
    scheduler = result.scheduler;
    scheduler.schedule(1);
    scheduler.flushPending();
    expect(seen).toEqual([1]);
    result.fire();
    expect(seen).toEqual([1, 2]);
  });
});
