import { describe, expect, it, vi } from 'vitest';

import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { StreamingUIHost } from '#/tui/controllers/streaming-ui';
import type { TUIState } from '#/tui/kimi-tui';
import type { AppState, QueuedMessage } from '#/tui/types';

function makeHost(args: { goal?: AppState['goal'] } = {}): {
  host: StreamingUIHost;
} {
  const state = {
    appState: {
      streamingPhase: 'waiting',
      streamingStartTime: 1,
      sessionTitle: 'Test session',
      goal: args.goal,
      notifications: {
        enabled: true,
        condition: 'unfocused' as const,
      },
    },
    terminalState: {
      notificationKeys: new Set<string>(),
      focused: false,
      supportsOsc9: true,
      insideTmux: false,
    },
    terminal: {
      write: vi.fn(),
    },
    ui: { requestRender: vi.fn() },
  } as unknown as TUIState;

  const host: StreamingUIHost = {
    state,
    session: undefined,
    setAppState: (patch) => {
      Object.assign(state.appState, patch);
    },
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(() => {
      throw new Error('no session');
    }),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(() => undefined),
    pushTranscriptEntry: vi.fn(),
    mergeCurrentTurnSteps: vi.fn(),
  };

  return { host };
}

describe('StreamingUIController.finalizeTurn', () => {
  it('returns false and idles the UI when no queued message exists', () => {
    const { host } = makeHost({ goal: null });
    const controller = new StreamingUIController(host);
    controller.setTurnId('t1');

    const result = controller.finalizeTurn(vi.fn());

    expect(result).toBe(false);
    expect(host.state.appState.streamingPhase).toBe('idle');
    expect(host.resetLivePane).toHaveBeenCalled();
  });

  it('returns true and schedules a queued message instead of idling', async () => {
    const { host } = makeHost({ goal: null });
    const next: QueuedMessage = { text: 'continue' };
    host.shiftQueuedMessage = vi.fn(() => next);
    const sendQueued = vi.fn();
    const controller = new StreamingUIController(host);
    controller.setTurnId('t1');

    const result = controller.finalizeTurn(sendQueued);

    expect(result).toBe(true);
    expect(host.state.appState.streamingPhase).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendQueued).toHaveBeenCalledWith(next);
  });

  it('does nothing when the streaming phase is already idle', () => {
    const { host } = makeHost({ goal: null });
    host.state.appState.streamingPhase = 'idle';
    const controller = new StreamingUIController(host);

    const result = controller.finalizeTurn(vi.fn());

    expect(result).toBe(false);
    expect(host.resetLivePane).not.toHaveBeenCalled();
  });
});
