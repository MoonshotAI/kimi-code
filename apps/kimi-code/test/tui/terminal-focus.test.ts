import { describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/kimi-tui';
import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
  handleTerminalFocusInput,
  installTerminalFocusTracking,
} from '#/tui/utils/terminal-focus';

describe('terminal focus tracking', () => {
  it('updates focus state from terminal focus reporting sequences', () => {
    const state = { focused: true };

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_OUT)).toEqual({ consume: true });
    expect(state.focused).toBe(false);

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_IN)).toEqual({ consume: true });
    expect(state.focused).toBe(true);

    expect(handleTerminalFocusInput(state, 'x')).toBeUndefined();
  });

  it('ignores non-focus input sequences', () => {
    const state = { focused: true };
    expect(handleTerminalFocusInput(state, '')).toBeUndefined();
    expect(state.focused).toBe(true);
    expect(handleTerminalFocusInput(state, '\u001b')).toBeUndefined();
    expect(state.focused).toBe(true);
  });

  it('enables focus reporting and removes the listener on dispose', () => {
    const listeners: Array<(data: string) => { consume: true } | undefined> = [];
    const removeInputListener = vi.fn();
    const state = {
      terminalState: {
        focused: false,
      },
      terminal: {
        write: vi.fn(),
      },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return removeInputListener;
        }),
      },
    } as unknown as TUIState;

    const dispose = installTerminalFocusTracking(state);

    expect(state.terminalState.focused).toBe(true);
    expect(state.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_FOCUS_REPORTING);
    expect(listeners).toHaveLength(1);

    listeners[0]?.(TERMINAL_FOCUS_OUT);
    expect(state.terminalState.focused).toBe(false);

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_FOCUS_REPORTING);
    expect(state.terminalState.focused).toBe(true);
  });

  it('dispose is idempotent (calling twice does not double-remove)', () => {
    const removeInputListener = vi.fn();
    const state = {
      terminalState: { focused: false },
      terminal: { write: vi.fn() },
      ui: { addInputListener: vi.fn(() => removeInputListener) },
    } as unknown as TUIState;

    const dispose = installTerminalFocusTracking(state);
    dispose();
    dispose();

    expect(removeInputListener).toHaveBeenCalledTimes(1);
  });

  it('rapid focus in/out sequences are handled correctly', () => {
    const state = { focused: true };
    for (let i = 0; i < 100; i++) {
      handleTerminalFocusInput(state, TERMINAL_FOCUS_OUT);
      expect(state.focused).toBe(false);
      handleTerminalFocusInput(state, TERMINAL_FOCUS_IN);
      expect(state.focused).toBe(true);
    }
  });
});
