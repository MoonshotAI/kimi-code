import { describe, expect, it, vi } from 'vitest';

import { PanelQueue } from '#/tui/interactions/panel-queue';

class TestQueue extends PanelQueue<string, string> {}

class AutoQueue extends PanelQueue<{ action: string; id: string }, string> {
  protected override autoResolveFor(
    resolved: { action: string; id: string },
    response: string,
    queued: { action: string; id: string },
  ): string | undefined {
    if (response === 'approve_all_same' && resolved.action === queued.action) {
      return `auto:${queued.id}`;
    }
    return undefined;
  }
}

describe('PanelQueue', () => {
  it('shows a payload, resolves the pending promise on respond, and hides the panel', async () => {
    const queue = new TestQueue();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel, hidePanel });

    const pending = queue.show('payload');
    expect(queue.hasPending()).toBe(true);
    expect(showPanel).toHaveBeenCalledWith('payload');

    queue.respond('approved');

    await expect(pending).resolves.toBe('approved');
    expect(queue.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('queues concurrent show() requests and presents them one at a time', async () => {
    const queue = new TestQueue();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel, hidePanel });

    const first = queue.show('first');
    const second = queue.show('second');
    const third = queue.show('third');

    // Only the first is presented; the rest stay queued.
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(showPanel).toHaveBeenLastCalledWith('first');
    expect(queue.hasPending()).toBe(true);

    queue.respond('answer-first');
    await expect(first).resolves.toBe('answer-first');
    // Advancing to the next queued request reuses the same panel without
    // hiding it in between.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(2);
    expect(showPanel).toHaveBeenLastCalledWith('second');

    queue.respond('answer-second');
    await expect(second).resolves.toBe('answer-second');
    expect(showPanel).toHaveBeenCalledTimes(3);
    expect(showPanel).toHaveBeenLastCalledWith('third');

    queue.respond('answer-third');
    await expect(third).resolves.toBe('answer-third');
    expect(queue.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves matching queued requests via the autoResolveFor hook', async () => {
    const queue = new AutoQueue();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel, hidePanel });

    const first = queue.show({ action: 'run', id: 'a' });
    const second = queue.show({ action: 'run', id: 'b' });
    const third = queue.show({ action: 'edit', id: 'c' });
    const fourth = queue.show({ action: 'run', id: 'd' });

    queue.respond('approve_all_same');

    await expect(first).resolves.toBe('approve_all_same');
    await expect(second).resolves.toBe('auto:b');
    await expect(fourth).resolves.toBe('auto:d');
    // The non-matching request advances to the panel and stays pending.
    expect(showPanel).toHaveBeenLastCalledWith({ action: 'edit', id: 'c' });
    expect(queue.hasPending()).toBe(true);

    queue.respond('approve_all_same');
    await expect(third).resolves.toBe('approve_all_same');
    expect(queue.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('retractAll resolves every pending with undefined and hides the panel', async () => {
    const queue = new TestQueue();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const first = queue.show('first');
    const second = queue.show('second');
    const third = queue.show('third');

    queue.retractAll();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(queue.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('retract resolves the matching current entry with undefined and advances', async () => {
    const queue = new PanelQueue<{ id: string }, string>();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel, hidePanel });

    const first = queue.show({ id: 'a' });
    const second = queue.show({ id: 'b' });

    queue.retract((payload) => payload.id === 'a');
    await expect(first).resolves.toBeUndefined();
    // 'b' advances into the active panel without an intervening hide.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenLastCalledWith({ id: 'b' });

    queue.respond('answer-b');
    await expect(second).resolves.toBe('answer-b');
  });

  it('retract drops matching queued entries without hiding the active panel', async () => {
    const queue = new PanelQueue<{ id: string }, string>();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    queue.setUIHooks({ showPanel, hidePanel });

    const first = queue.show({ id: 'a' });
    const second = queue.show({ id: 'b' });
    const third = queue.show({ id: 'c' });

    queue.retract((payload) => payload.id === 'b');
    await expect(second).resolves.toBeUndefined();
    // The current panel ('a') is untouched.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(1);

    queue.respond('answer-a');
    await expect(first).resolves.toBe('answer-a');
    // 'c' advances — 'b' was removed from the queue.
    expect(showPanel).toHaveBeenLastCalledWith({ id: 'c' });
    queue.respond('answer-c');
    await expect(third).resolves.toBe('answer-c');
  });
});
