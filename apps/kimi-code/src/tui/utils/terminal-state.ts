import {
  isInsideTmux,
  supportsOsc9Notification,
  supportsTerminalProgress,
} from './terminal-notification';

export interface TerminalState {
  notificationKeys: Set<string>;
  focused: boolean;
  supportsOsc9: boolean;
  supportsProgress: boolean;
  insideTmux: boolean;
  progressActive: boolean;
}

export function createTerminalState(): TerminalState {
  return {
    notificationKeys: new Set<string>(),
    focused: true,
    supportsOsc9: supportsOsc9Notification(),
    supportsProgress: supportsTerminalProgress(),
    insideTmux: isInsideTmux(),
    progressActive: false,
  };
}
