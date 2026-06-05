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
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
  installTerminalMouseTracking,
  isPrimaryMousePress,
  parseSgrMouseEvent,
} from '#/tui/utils/editor-mouse';

describe('terminal focus tracking', () => {
  it('updates focus state from terminal focus reporting sequences', () => {
    const state = { focused: true };

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_OUT)).toEqual({ consume: true });
    expect(state.focused).toBe(false);

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_IN)).toEqual({ consume: true });
    expect(state.focused).toBe(true);

    expect(handleTerminalFocusInput(state, 'x')).toBeUndefined();
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
});

describe('terminal mouse tracking', () => {
  it('parses SGR mouse events and recognizes primary button presses', () => {
    const press = parseSgrMouseEvent('\u001B[<0;12;4M');
    expect(press).toEqual({ button: 0, col: 12, row: 4, final: 'M' });
    expect(press === undefined ? false : isPrimaryMousePress(press)).toBe(true);

    const modifiedPress = parseSgrMouseEvent('\u001B[<16;12;4M');
    expect(modifiedPress === undefined ? false : isPrimaryMousePress(modifiedPress)).toBe(true);

    const release = parseSgrMouseEvent('\u001B[<0;12;4m');
    expect(release === undefined ? false : isPrimaryMousePress(release)).toBe(false);

    expect(parseSgrMouseEvent('\u001B[12;4H')).toBeUndefined();
  });

  it('enables mouse reporting, consumes mouse input, and disables it on dispose', () => {
    const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const removeInputListener = vi.fn();
    const onMouseEvent = vi.fn();
    const state = {
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

    const dispose = installTerminalMouseTracking(state, onMouseEvent);

    expect(state.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_MOUSE_REPORTING);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.('\u001B[<0;12;4M')).toEqual({ consume: true });
    expect(onMouseEvent).toHaveBeenCalledWith({ button: 0, col: 12, row: 4, final: 'M' });
    expect(listeners[0]?.('x')).toBeUndefined();

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_MOUSE_REPORTING);
  });
});
