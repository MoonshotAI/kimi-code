import { describe, expect, it, vi } from 'vitest';
import { dismissToastByKey, onToast, toast, type ToastEvent } from '../src/client/toast';

describe('toast channel', () => {
  it('emits show events with options and key', () => {
    const events: ToastEvent[] = [];
    const off = onToast((event) => events.push(event));
    toast({ title: 'hello' });
    toast({ title: 'bye', mode: 'replace' }, 7);
    off();
    expect(events).toEqual([
      { type: 'show', options: { title: 'hello' }, key: undefined },
      { type: 'show', options: { title: 'bye', mode: 'replace' }, key: 7 },
    ]);
  });

  it('emits dismiss events and stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = onToast(listener);
    dismissToastByKey(3);
    off();
    dismissToastByKey(4);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'dismiss', key: 3 });
  });
});
