import type { IDisposable } from '@moonshot-ai/agent-core-v2';
import type { IHostBrowser } from './browser-host-contract';
import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import {
  DESKTOP_BROWSER_CONTROL_OFF_REASON,
  DESKTOP_BROWSER_TOOL,
  DESKTOP_BROWSER_UNAVAILABLE_NOTICE,
  describeBlockedDesktopBrowser,
  runDesktopBrowserTool,
  type DesktopBrowserAccess,
  type DesktopBrowserAgentControl,
} from './browser-tool';
import { BrowserSubagentRunRegistry, type DesktopBrowserSubagentRun } from './browser-subagent-control';
import { restoreBrowserSubagentRuns, revokeBrowserSubagentRun } from './browser-control';
import type { BrowserControlTrigger } from '../diagnostics/telemetry-events';
import type { BrowserDialogReminder } from './browser-automation';
import { formatBrowserDialogReminder } from './browser-dialog-reminder';

export const DESKTOP_BROWSER_REMINDER_VARIANT = 'desktop_browser';

export const DESKTOP_BROWSER_ENABLED_REMINDER = 'For web and browser tasks, use the built-in browser of Kimi Code Desktop: call select_tools with `mcp__desktop_browser__run` to load it. Use the kimi-webbridge skill only when the user explicitly asks to use their own Chrome or Edge browser, or sessions they are logged into there.';
export const DESKTOP_BROWSER_DIRECT_REMINDER = 'For web and browser tasks, use the built-in browser of Kimi Code Desktop: call `mcp__desktop_browser__run`. Use the kimi-webbridge skill only when the user explicitly asks to use their own Chrome or Edge browser, or sessions they are logged into there.';
export const DESKTOP_BROWSER_DISABLED_REMINDER = describeBlockedDesktopBrowser('The user turned off agent control of the built-in browser in Kimi Code Settings > Browser, so `mcp__desktop_browser__run` is unavailable. Do not try to load or call it.');

const SUBAGENT_CONTROL_DISABLED: DesktopBrowserAgentControl = { enabled: () => false, onDidChange: () => () => {} };

export interface DesktopBrowserDialogSource {
  collect(sessionId: string): Promise<BrowserDialogReminder | undefined>;
}

export interface DesktopBrowserHost extends IHostBrowser, DesktopBrowserAccess, IDisposable {
  readonly control: DesktopBrowserAgentControl;
  readonly subagentControl: DesktopBrowserAgentControl;
  readonly kept: Set<string>;
  readonly runs: BrowserSubagentRunRegistry;
  resolveRun(sessionId: string, run: BrowserSubagentRun): DesktopBrowserSubagentRun | null;
}

export function createDesktopBrowserHost(
  control: DesktopBrowserAgentControl,
  subagentControl: DesktopBrowserAgentControl = SUBAGENT_CONTROL_DISABLED,
  dialogs?: DesktopBrowserDialogSource,
): DesktopBrowserHost {
  const kept = new Set<string>();
  const runs = new BrowserSubagentRunRegistry(() => control.enabled() && subagentControl.enabled());
  const availability = new Emitter<void>();
  let revokeTrigger: BrowserControlTrigger | undefined;
  const syncSubagentRuns = (): void => {
    if (control.enabled() && subagentControl.enabled()) {
      restoreBrowserSubagentRuns();
      return;
    }
    revokeTrigger = 'ipc';
    try {
      runs.revokeAll();
    } finally {
      revokeTrigger = undefined;
    }
  };
  const subscriptions = [
    control.onDidChange((enabled) => {
      syncSubagentRuns();
      if (enabled) kept.clear();
      availability.fire();
    }),
    subagentControl.onDidChange(syncSubagentRuns),
    runs.onDidRevoke((sessionId, run) => revokeBrowserSubagentRun(sessionId, run, revokeTrigger)),
  ];
  const host: DesktopBrowserHost = {
    _serviceBrand: undefined,
    control,
    subagentControl,
    kept,
    runs,
    tool: DESKTOP_BROWSER_TOOL,
    messages: {
      enabledReminder: DESKTOP_BROWSER_ENABLED_REMINDER,
      directReminder: DESKTOP_BROWSER_DIRECT_REMINDER,
      disabledReminder: DESKTOP_BROWSER_DISABLED_REMINDER,
      unavailableNotice: DESKTOP_BROWSER_UNAVAILABLE_NOTICE,
      controlOffReason: DESKTOP_BROWSER_CONTROL_OFF_REASON,
      describeBlocked: describeBlockedDesktopBrowser,
    },
    onDidChangeAvailability: availability.event,
    allows: (sessionId) => control.enabled() || kept.has(sessionId),
    keepSession: (sessionId) => { kept.add(sessionId); },
    resolveRun: (sessionId, run) => runs.resolve(sessionId, run),
    run: (request) => runDesktopBrowserTool(host, request),
    attachSubagent: (sessionId, agent) => runs.attach(sessionId, agent),
    describeSubagent: (sessionId, agentId, generation, description) => runs.describe(sessionId, agentId, generation, description),
    finishSubagentTurn: (sessionId, run) => runs.finish(sessionId, run),
    closeSubagent: (sessionId, agentId, generation) => runs.closeAgent(sessionId, agentId, generation),
    closeSession: (sessionId) => {
      runs.closeSession(sessionId);
      kept.delete(sessionId);
    },
    dialogReminder: async (sessionId) => {
      const reminder = await dialogs?.collect(sessionId);
      return reminder === undefined ? undefined : formatBrowserDialogReminder(reminder);
    },
    dispose: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      availability.dispose();
      kept.clear();
    },
  };
  return host;
}
