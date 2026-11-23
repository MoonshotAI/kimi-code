import type { ContextInjectionContext, IAgentScopeHandle, IDisposable, ISessionScopeHandle, Scope } from '@moonshot-ai/agent-core-v2';
import { IAgentLifecycleService, IAgentReminderService, MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import type { BrowserDialogRecord, BrowserPendingDialog } from '../../shared/browser-dialogs';
import type { BrowserDialogReminder } from './browser-automation';

export const DESKTOP_BROWSER_DIALOGS_REMINDER_VARIANT = 'desktop-browser-dialogs';

export interface BrowserDialogReminderSource {
  collect(sessionId: string): Promise<BrowserDialogReminder | undefined>;
  forgetSession(sessionId: string): void;
}

const ANSWERERS: Record<BrowserDialogRecord['answerer'], string> = { agent: 'you', user: 'the user', auto: 'the app automatically' };

function quoted(text: string | undefined): string {
  return text ? ` ${JSON.stringify(text)}` : '';
}

function pendingLine(dialog: BrowserPendingDialog): string {
  const target = dialog.target ? ` for ${JSON.stringify(dialog.target)}` : '';
  const files = dialog.files?.length ? ` with files ${dialog.files.map(file => JSON.stringify(file)).join(', ')}` : '';
  const answer = dialog.answerer === 'user'
    ? 'the user can answer it in the browser panel'
    : 'answer it with page.dialog.respond or let the user answer it in the browser panel';
  const defaultValue = dialog.defaultValue ? ` with default text ${JSON.stringify(dialog.defaultValue)}` : '';
  return `- ${dialog.kind}${quoted(dialog.message)} from ${dialog.origin || 'the page'}${target}${files}${defaultValue} (dialogId ${dialog.dialogId}) is still waiting for an answer; ${answer}.`;
}

function handledLine(record: BrowserDialogRecord): string {
  const files = record.files?.length ? ` (files: ${record.files.map(file => JSON.stringify(file)).join(', ')})` : '';
  const text = record.text === undefined ? '' : ` (text: ${JSON.stringify(record.text)})`;
  return `- ${record.kind}${quoted(record.message)} from ${record.origin || 'the page'}: ${record.outcome} by ${ANSWERERS[record.answerer]}${files}${text}.`;
}

export function formatBrowserDialogReminder(reminder: BrowserDialogReminder): string {
  const lines = ['The built-in browser had page dialogs you have not seen since your last browser result. Pages may have changed while a dialog was open; check the page before relying on earlier results.'];
  for (const tab of reminder.tabs) {
    const pending = reminder.pendingDialogs.filter(dialog => dialog.tabId === tab.tabId);
    const handled = reminder.handledDialogs.filter(record => record.tabId === tab.tabId);
    lines.push(`Tab ${tab.tabId}${quoted(tab.title)}${tab.url ? ` (${JSON.stringify(tab.url)})` : ''}:`, ...handled.map(handledLine), ...pending.map(pendingLine));
  }
  if (reminder.more) lines.push('More browser dialog events are queued and will be reported with the next browser result.');
  return lines.join('\n');
}

function dialogReminder(sessionId: string, source: BrowserDialogReminderSource) {
  return async (context: ContextInjectionContext) => {
    if (!context.isNewTurn) return undefined;
    const reminder = await source.collect(sessionId);
    return reminder === undefined ? undefined : formatBrowserDialogReminder(reminder);
  };
}

export function registerDesktopBrowserDialogReminder(core: Scope, source: BrowserDialogReminderSource): IDisposable {
  const sessions = core.accessor.get(ISessionManager);
  if (sessions.onDidCreateSession === undefined) throw new Error('Session creation hooks are unavailable');
  const attached = new Map<string, () => void>();
  let disposed = false;

  const attachSession = (session: ISessionScopeHandle): void => {
    if (disposed || attached.has(session.id)) return;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    let registration: IDisposable | undefined;
    const attachAgent = (agentId: string, handle: IAgentScopeHandle | undefined): void => {
      if (agentId !== MAIN_AGENT_ID || handle === undefined || registration !== undefined) return;
      registration = handle.accessor.get(IAgentReminderService).register(DESKTOP_BROWSER_DIALOGS_REMINDER_VARIANT, dialogReminder(session.id, source));
    };
    const created = lifecycle.onDidCreateScope(({ context, handle }) => attachAgent(context.agentId, handle));
    const closed = lifecycle.onDidClose(({ agentId }) => {
      if (agentId !== MAIN_AGENT_ID) return;
      registration?.dispose();
      registration = undefined;
    });
    attached.set(session.id, () => {
      created.dispose();
      closed.dispose();
      registration?.dispose();
      registration = undefined;
    });
    attachAgent(MAIN_AGENT_ID, lifecycle.handleOf(MAIN_AGENT_ID));
  };
  const detachSession = (sessionId: string): void => {
    attached.get(sessionId)?.();
    attached.delete(sessionId);
  };

  const subscriptions: IDisposable[] = [sessions.onDidCreateSession(event => attachSession(event.handle))];
  if (sessions.onDidCloseSession !== undefined) subscriptions.push(sessions.onDidCloseSession(({ sessionId }) => detachSession(sessionId)));
  if (sessions.onWillDeleteSession !== undefined) {
    subscriptions.push(sessions.onWillDeleteSession(({ sessionId }) => {
      detachSession(sessionId);
      source.forgetSession(sessionId);
    }));
  }
  for (const session of sessions.list()) attachSession(session);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      for (const sessionId of Array.from(attached.keys())) detachSession(sessionId);
    },
  };
}
