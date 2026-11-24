import type { DesktopBrowserAgentControl } from './browser-tool';
import { getBrowserPreferences } from '../app/ui-state';

const listeners = new Set<(enabled: boolean) => void>();
let current: boolean | undefined;

export const browserAgentControl: DesktopBrowserAgentControl = {
  enabled: () => (current ??= getBrowserPreferences().agentControl),
  onDidChange(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function setBrowserAgentControl(enabled: boolean): void {
  if (current === enabled) return;
  current = enabled;
  for (const listener of listeners) listener(enabled);
}

const subagentListeners = new Set<(enabled: boolean) => void>();
let subagentCurrent: boolean | undefined;

export const browserSubagentControl: DesktopBrowserAgentControl = {
  enabled: () => (subagentCurrent ??= getBrowserPreferences().subagentControl),
  onDidChange(listener) {
    subagentListeners.add(listener);
    return () => { subagentListeners.delete(listener); };
  },
};

export function setBrowserSubagentControl(enabled: boolean): void {
  if (subagentCurrent === enabled) return;
  subagentCurrent = enabled;
  for (const listener of subagentListeners) listener(enabled);
}
