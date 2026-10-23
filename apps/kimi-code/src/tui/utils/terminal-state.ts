import {
  isInsideTmux,
  supportsOsc9Notification,
  supportsTerminalProgress,
} from './terminal-notification';

export interface TerminalState {
  notificationKeys: Set<string>;
  focused: boolean;
  /** `Date.now()` of the last focus-in report; 0 before the first one. */
  focusedAt: number;
  supportsOsc9: boolean;
  supportsProgress: boolean;
  insideTmux: boolean;
  progressActive: boolean;
}

export function createTerminalState(): TerminalState {
  return {
    notificationKeys: new Set<string>(),
    focused: true,
    focusedAt: 0,
    supportsOsc9: supportsOsc9Notification(),
    supportsProgress: supportsTerminalProgress(),
    insideTmux: isInsideTmux(),
    progressActive: false,
  };
}
