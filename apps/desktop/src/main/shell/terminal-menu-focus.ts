let terminalFocused = false;
const terminalFocusListeners = new Set<(focused: boolean) => void>();

export function onTerminalMenuFocus(listener: (focused: boolean) => void): void {
  terminalFocusListeners.add(listener);
}

export function setTerminalMenuFocus(focused: boolean): void {
  if (focused === terminalFocused) {
    return;
  }
  terminalFocused = focused;
  for (const listener of terminalFocusListeners) listener(focused);
}

export function getTerminalMenuFocus(): boolean {
  return terminalFocused;
}
