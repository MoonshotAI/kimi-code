import type { IDisposable, Scope } from '@moonshot-ai/agent-core-v2';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import type { BrowserDialogRecord, BrowserPendingDialog } from '../../shared/browser-dialogs';
import type { BrowserDialogReminder } from './browser-automation';

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

export function registerBrowserDialogCleanup(core: Scope, forgetSession: (sessionId: string) => void): IDisposable {
  const sessions = core.accessor.get(ISessionManager);
  return sessions.onWillDeleteSession?.(({ sessionId }) => forgetSession(sessionId)) ?? { dispose: () => {} };
}
