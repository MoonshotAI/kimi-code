import {
  CLICK_GUARD_MS,
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';
import type { TerminalState } from '#/tui/utils/terminal-state';

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';

/** Whether a click lands too soon after `since` (a prompt appearing, the window regaining focus) to be deliberate. */
export function isSettlingClick(since: number, now = Date.now()): boolean {
  return now - since < CLICK_GUARD_MS;
}

/** Whether a click is most likely the one that focused the terminal window. */
export function isFocusingClick(
  state: Pick<TerminalState, 'focusedAt'>,
  now = Date.now(),
): boolean {
  return isSettlingClick(state.focusedAt, now);
}

export function installTerminalFocusTracking(state: TUIState): () => void {
  state.terminalState.focused = true;
  state.editor.terminalFocused = true;
  const disposeInputListener = state.ui.addInputListener((data) => {
    const result = handleTerminalFocusInput(state.terminalState, data);
    if (result !== undefined) {
      state.editor.terminalFocused = state.terminalState.focused;
      state.ui.requestRender();
    }
    return result;
  });
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
    state.editor.terminalFocused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, 'focused' | 'focusedAt'>,
  data: string,
  now = Date.now(),
): { consume: true } | undefined {
  if (data === TERMINAL_FOCUS_IN) {
    state.focused = true;
    state.focusedAt = now;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT) {
    state.focused = false;
    return { consume: true };
  }
  return undefined;
}
