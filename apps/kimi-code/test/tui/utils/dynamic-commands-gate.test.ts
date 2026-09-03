import { describe, expect, it, vi } from 'vitest';

import { DYNAMIC_COMMANDS_READY_TIMEOUT_MS } from '#/tui/constant/kimi-tui';
import { createDynamicCommandsGate } from '#/tui/utils/dynamic-commands-gate';

describe('createDynamicCommandsGate', () => {
  it('clears the gate with a warning when the catalog load does not settle in time', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let resolveLoad!: () => void;
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      const ready = createDynamicCommandsGate(load, onTimeout);

      await vi.advanceTimersByTimeAsync(DYNAMIC_COMMANDS_READY_TIMEOUT_MS);

      expect(onTimeout).toHaveBeenCalledWith(
        'Skill and plugin catalogs are still loading — slash commands may be incomplete for a moment.',
      );
      await ready;

      // A load that settles after the timeout still resolves quietly — the
      // warning fires once.
      resolveLoad();
      await ready;
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves without warning when the load settles before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let resolveLoad!: () => void;
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      const ready = createDynamicCommandsGate(load, onTimeout);

      resolveLoad();
      await ready;
      await vi.advanceTimersByTimeAsync(DYNAMIC_COMMANDS_READY_TIMEOUT_MS * 2);

      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves even when the load rejects, so queued drains are never dropped', async () => {
    const ready = createDynamicCommandsGate(Promise.reject(new Error('wedged IPC')), vi.fn());
    await expect(ready).resolves.toBeUndefined();
  });
});
