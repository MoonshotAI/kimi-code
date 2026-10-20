import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { compactForModelSwitch } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

type TestEvent = { type: string; code?: string };

function fakeSession() {
  const listeners = new Set<(event: TestEvent) => void>();
  const compact = vi.fn(async () => undefined);
  const session = {
    onEvent: (listener: (event: TestEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    compact,
  } as unknown as Session;
  return {
    session,
    compact,
    listenerCount: () => listeners.size,
    emit: (event: TestEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function fakeHost(session: Session) {
  return {
    session,
    showError: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('compactForModelSwitch', () => {
  it('compacts and proceeds once the completed event lands', async () => {
    const { session, compact, emit, listenerCount } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed' });

    await expect(pending).resolves.toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
  });

  it('aborts with a notice when the compaction is cancelled', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.cancelled' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Compaction cancelled — model unchanged.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('aborts when the compaction fails', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'error', code: 'compaction.failed' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — model unchanged.');
  });

  it('aborts when the compact request itself rejects', async () => {
    const { session, compact } = fakeSession();
    compact.mockRejectedValue(new Error('engine busy'));
    const host = fakeHost(session);

    await expect(compactForModelSwitch(host, session)).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith('Failed to compact: engine busy. Model unchanged.');
  });

  it('aborts when the session changed while waiting', async () => {
    const { session, emit } = fakeSession();
    const { session: otherSession } = fakeSession();
    const host = fakeHost(otherSession);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — session changed.');
  });

  it('aborts with an error when the compaction never settles', async () => {
    vi.useFakeTimers();
    const { session } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(pending).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith('Timed out waiting for compaction — model unchanged.');
  });
});
