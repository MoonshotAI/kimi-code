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
    expect(state).toEqual({ focused: true });

    expect(handleTerminalFocusInput(state, 'x')).toBeUndefined();
  });

  it('notifies only on an actual unfocused-to-focused transition', () => {
    const state = { focused: true };
    const onFocusIn = vi.fn();

    handleTerminalFocusInput(state, TERMINAL_FOCUS_IN, onFocusIn);
    expect(onFocusIn).not.toHaveBeenCalled();

    handleTerminalFocusInput(state, TERMINAL_FOCUS_OUT, onFocusIn);
    handleTerminalFocusInput(state, TERMINAL_FOCUS_IN, onFocusIn);
    handleTerminalFocusInput(state, TERMINAL_FOCUS_IN, onFocusIn);
    expect(onFocusIn).toHaveBeenCalledTimes(1);
  });

  it('enables focus reporting and removes the listener on dispose', () => {
    const listeners: Array<(data: string) => { consume: true } | undefined> = [];
    const removeInputListener = vi.fn();
    const state = {
      terminalState: {
        focused: false,
      },
      editor: {
        focused: true,
        terminalFocused: false,
      },
      terminal: {
        write: vi.fn(),
      },
      ui: {
        requestRender: vi.fn(),
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
    expect(state.editor.terminalFocused).toBe(false);
    expect(state.editor.focused).toBe(true);
    expect(state.ui.requestRender).toHaveBeenCalledOnce();

    listeners[0]?.(TERMINAL_FOCUS_IN);
    expect(state.editor.terminalFocused).toBe(true);
    expect(state.ui.requestRender).toHaveBeenCalledTimes(2);

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_FOCUS_REPORTING);
    expect(state.terminalState.focused).toBe(true);
  });
});
