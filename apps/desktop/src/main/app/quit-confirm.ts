import { app, dialog } from 'electron';
import type { BaseWindow, MessageBoxOptions } from 'electron';

import { embeddedServerOrigin } from '../server/connect';
import { listBusySessions, type BusySession } from '../server/session-continue';
import { desktopServerSecret } from '../server/server-auth';
import { IPC } from '../ipc/ipc-channels';
import { log } from '../diagnostics/log';
import { trackDesktopEvent } from '../diagnostics/track';
import type { RestartDecision } from '../release/updater';
import {
  updateRestartMessage,
  type QuitBlockReason,
  type QuitConfirmDetails,
  type QuitConfirmPurpose,
} from '../../shared/quit-confirm';
import { setRemoteControlPreviousEnabled } from './ui-state';
import type { TrayLocale } from '../shell/tray';
import { addMainWindowCloseInterceptor, isQuitConfirmSkipped, isRendererReady, onMainWindowGone, sendToRenderer, showMainWindow } from '../window/main-window';

const BUSY_SESSIONS_QUERY_TIMEOUT_MS = 1_500;

interface QuitConfirmPrompt extends QuitConfirmDetails {
  readonly reasons: QuitBlockReason[];
  readonly runningSessionIds: readonly string[];
}

interface QuitConfirmAnswer {
  readonly quit: boolean;
  readonly continueSessionIds: readonly string[];
}

interface QuitConfirmStrings {
  title: string;
  detail: string;
  detailRemoteControl: string;
  detailBoth: string;
  cancel: string;
  quit: string;
  updateTitle: string;
  updateDetail: string;
  updateDetailSessions: string;
  updateMoreSessions: string;
  updateDetailRemoteControl: string;
  updateContinueSessions: string;
  updateConfirm: string;
}

const QUIT_CONFIRM_STRINGS: Record<TrayLocale, QuitConfirmStrings> = {
  zh: {
    title: '退出 Kimi Code？',
    detail: '还有会话在进行，退出会中断它们。',
    detailRemoteControl: '远程控制正在运行，退出客户端会停止远程控制',
    detailBoth: '还有会话在进行，退出会中断它们；远程控制正在运行，退出客户端会停止远程控制',
    cancel: '取消',
    quit: '退出',
    updateTitle: '重启并更新 Kimi Code？',
    updateDetail: '还有会话在进行，重启会中断它们。',
    updateDetailSessions: '以下会话正在进行，重启会中断它们：',
    updateMoreSessions: '以及其他 {count} 个会话',
    updateDetailRemoteControl: '远程控制正在运行，重启会中断远程控制',
    updateContinueSessions: '重启后继续这些会话',
    updateConfirm: '重启并更新',
  },
  en: {
    title: 'Quit Kimi Code?',
    detail: 'Sessions are still in progress on this machine and will be interrupted if you quit.',
    detailRemoteControl: 'Remote Control is running. Quitting the app will stop it',
    detailBoth:
      'Sessions are still in progress and will be interrupted. Remote Control is also running — quitting the app will stop it',
    cancel: 'Cancel',
    quit: 'Quit',
    updateTitle: 'Restart and update Kimi Code?',
    updateDetail: 'Sessions are still in progress on this machine and will be interrupted by the restart.',
    updateDetailSessions: 'These sessions are still in progress and will be interrupted by the restart:',
    updateMoreSessions: 'and {count} more',
    updateDetailRemoteControl: 'Remote Control is running and will be interrupted by the restart',
    updateContinueSessions: 'Continue these sessions after restart',
    updateConfirm: 'Restart & Update',
  },
};

let quitConfirmLocale: TrayLocale | null = null;

export function setQuitConfirmLocale(locale: TrayLocale | null): void {
  quitConfirmLocale = locale;
}

function effectiveQuitConfirmLocale(): TrayLocale {
  if (quitConfirmLocale !== null) return quitConfirmLocale;
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function quitConfirmStrings(locale: TrayLocale): QuitConfirmStrings {
  return QUIT_CONFIRM_STRINGS[locale];
}

export function hasBusySession(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const data = (payload as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return false;
  const items = (data as { items?: unknown }).items;
  return Array.isArray(items) && items.length > 0;
}

export function parseRemoteControlEnabled(payload: unknown): boolean | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  if ((payload as { code?: unknown }).code !== 0) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return undefined;
  const enabled = (data as { enabled?: unknown }).enabled;
  const state = (data as { state?: unknown }).state;
  if (enabled === true && state === 'on') return true;
  if (state === 'starting') return true;
  if (enabled === false && (state === 'off' || state === 'stopping')) return false;
  return undefined;
}

export function remoteControlEnabled(payload: unknown): boolean {
  return parseRemoteControlEnabled(payload) === true;
}

export function busySessionsUrl(origin: string): string {
  return `${origin}/api/v1/sessions?busy=true&page_size=1&archived=all`;
}

export function remoteControlStatusUrl(origin: string): string {
  return `${origin}/api/v1/remote-control`;
}

function trackQuitConfirmation(action: 'shown' | 'quit' | 'cancel'): void {
  try {
    trackDesktopEvent('quit_confirmation', { action });
  } catch {
    return;
  }
}

function warnQueryFailed(error: unknown): void {
  log.warn(
    `[kimi-desktop] quit confirmation: quit-block query failed (${error instanceof Error ? error.message : String(error)})`,
  );
}

async function requestJson(url: string, token: string | undefined): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BUSY_SESSIONS_QUERY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch (error) {
    warnQueryFailed(error);
    return undefined;
  }
}

async function queryBusySessions(
  origin: string,
  token: string | undefined,
  purpose: QuitConfirmPurpose,
): Promise<{ busy: boolean; sessions: BusySession[] }> {
  const [payload, sessions] = await Promise.all([
    requestJson(busySessionsUrl(origin), token),
    purpose === 'update' ? listSessionsToShow(origin, token) : Promise.resolve<BusySession[]>([]),
  ]);
  return { busy: hasBusySession(payload) || sessions.length > 0, sessions };
}

async function listSessionsToShow(origin: string, token: string | undefined): Promise<BusySession[]> {
  try {
    return await listBusySessions(origin, token, AbortSignal.timeout(BUSY_SESSIONS_QUERY_TIMEOUT_MS));
  } catch (error) {
    warnQueryFailed(error);
    return [];
  }
}

async function queryQuitPrompt(
  origin: string,
  token: string | undefined,
  purpose: QuitConfirmPurpose,
): Promise<QuitConfirmPrompt> {
  const [busySessions, remoteControlPayload] = await Promise.all([
    queryBusySessions(origin, token, purpose),
    requestJson(remoteControlStatusUrl(origin), token),
  ]);
  const reasons: QuitBlockReason[] = [];
  if (busySessions.busy) reasons.push('busy');
  const remoteControl = parseRemoteControlEnabled(remoteControlPayload);
  if (remoteControl !== undefined) {
    setRemoteControlPreviousEnabled(remoteControl);
    if (remoteControl) reasons.push('remote-control');
  }
  const running = busySessions.sessions.filter((session) => session.turnRunning);
  return {
    purpose,
    reasons,
    sessionTitles: running.map((session) => session.title),
    runningSessionIds: running.map((session) => session.id),
  };
}

function offersSessionContinue(prompt: QuitConfirmPrompt): boolean {
  return prompt.purpose === 'update' && prompt.runningSessionIds.length > 0;
}

function sessionsToContinue(prompt: QuitConfirmPrompt, checked: boolean): readonly string[] {
  return checked && offersSessionContinue(prompt) ? prompt.runningSessionIds : [];
}

export type QuitConfirmChoice = 'quit' | 'cancel' | 'unavailable';

let pendingQuitConfirmResolve: ((choice: QuitConfirmChoice, continueSessions: boolean) => void) | null = null;
let pendingQuitConfirmRequestId: number | null = null;
let quitConfirmRequestSeq = 0;
let activeQuitChecks = 0;

export function resolveQuitConfirmResponse(
  choice: QuitConfirmChoice,
  requestId?: number,
  continueSessions = false,
): void {
  if (requestId !== undefined && requestId !== pendingQuitConfirmRequestId) return;
  const resolve = pendingQuitConfirmResolve;
  pendingQuitConfirmResolve = null;
  pendingQuitConfirmRequestId = null;
  resolve?.(choice, continueSessions);
}

onMainWindowGone(() => {
  const requestId = pendingQuitConfirmRequestId;
  resolveQuitConfirmResponse('cancel');
  if (requestId !== null) sendToRenderer(IPC.quitConfirmCancel, requestId);
});

addMainWindowCloseInterceptor(() => {
  if (isQuitConfirmSkipped()) {
    resolveQuitConfirmResponse('cancel');
    return false;
  }
  if (pendingQuitConfirmRequestId !== null) {
    const requestId = pendingQuitConfirmRequestId;
    resolveQuitConfirmResponse('cancel');
    sendToRenderer(IPC.quitConfirmCancel, requestId);
    return true;
  }
  return activeQuitChecks > 0;
});

let quitConfirmChain: Promise<unknown> = Promise.resolve();

function enqueueQuitConfirm<T>(task: () => Promise<T>): Promise<T> {
  const run = quitConfirmChain.then(task, task);
  quitConfirmChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function confirmQuitInApp(win: BaseWindow, prompt: QuitConfirmPrompt): Promise<QuitConfirmAnswer | null> {
  return new Promise<QuitConfirmAnswer | null>((resolve) => {
    const requestId = ++quitConfirmRequestSeq;
    pendingQuitConfirmResolve = (choice, continueSessions) => {
      if (choice === 'unavailable') {
        sendToRenderer(IPC.quitConfirmCancel, requestId);
        log.warn('[kimi-desktop] quit confirmation: renderer unavailable, falling back to native dialog');
        void confirmQuitNative(win, prompt).then(resolve);
        return;
      }
      resolve({ quit: choice === 'quit', continueSessionIds: sessionsToContinue(prompt, continueSessions) });
    };
    pendingQuitConfirmRequestId = requestId;
    showMainWindow();
    const details: QuitConfirmDetails = { purpose: prompt.purpose, sessionTitles: prompt.sessionTitles };
    sendToRenderer(IPC.quitConfirm, requestId, prompt.reasons, details);
  });
}

function quitConfirmDetail(locale: TrayLocale, reasons: QuitBlockReason[]): string {
  const strings = quitConfirmStrings(locale);
  const busy = reasons.includes('busy');
  const remoteControl = reasons.includes('remote-control');
  if (busy && remoteControl) return strings.detailBoth;
  if (remoteControl) return strings.detailRemoteControl;
  return strings.detail;
}

function updateRestartDetail(locale: TrayLocale, prompt: QuitConfirmPrompt): string {
  const strings = quitConfirmStrings(locale);
  return updateRestartMessage(
    {
      busy: strings.updateDetail,
      sessions: strings.updateDetailSessions,
      moreSessions: (count) => strings.updateMoreSessions.replace('{count}', String(count)),
      remoteControl: strings.updateDetailRemoteControl,
    },
    prompt.reasons,
    prompt.sessionTitles,
  );
}

function quitConfirmDialogOptions(locale: TrayLocale, prompt: QuitConfirmPrompt): MessageBoxOptions {
  const strings = quitConfirmStrings(locale);
  const update = prompt.purpose === 'update';
  const checkboxLabel = offersSessionContinue(prompt) ? strings.updateContinueSessions : undefined;
  return {
    type: 'warning',
    message: update ? strings.updateTitle : strings.title,
    detail: update ? updateRestartDetail(locale, prompt) : quitConfirmDetail(locale, prompt.reasons),
    buttons: [strings.cancel, update ? strings.updateConfirm : strings.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel,
    checkboxChecked: checkboxLabel !== undefined,
  };
}

async function confirmQuitNative(
  win: BaseWindow | null,
  prompt: QuitConfirmPrompt,
): Promise<QuitConfirmAnswer | null> {
  const options = quitConfirmDialogOptions(effectiveQuitConfirmLocale(), prompt);
  try {
    const { response, checkboxChecked } =
      win !== null && !win.isDestroyed() && win.isVisible()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return { quit: response === 1, continueSessionIds: sessionsToContinue(prompt, checkboxChecked) };
  } catch (error) {
    log.warn(`[kimi-desktop] quit confirmation skipped: dialog failed (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

async function runQuitConfirmation(
  win: BaseWindow | null,
  purpose: QuitConfirmPurpose,
  interceptWindowClose: boolean,
): Promise<QuitConfirmAnswer | null> {
  const origin = embeddedServerOrigin();
  if (origin === null) return null;
  if (interceptWindowClose) activeQuitChecks += 1;
  try {
    const prompt = await queryQuitPrompt(origin, desktopServerSecret(), purpose);
    if (prompt.reasons.length === 0) return null;
    const answer = await enqueueQuitConfirm(() => {
      trackQuitConfirmation('shown');
      return win !== null && !win.isDestroyed() && isRendererReady()
        ? confirmQuitInApp(win, prompt)
        : confirmQuitNative(win, prompt);
    });
    if (answer !== null) trackQuitConfirmation(answer.quit ? 'quit' : 'cancel');
    return answer;
  } finally {
    if (interceptWindowClose) activeQuitChecks -= 1;
  }
}

export async function shouldBlockQuit(
  win: BaseWindow | null,
  options: { interceptWindowClose?: boolean } = {},
): Promise<boolean> {
  const answer = await runQuitConfirmation(win, 'quit', options.interceptWindowClose ?? true);
  return answer !== null && !answer.quit;
}

export async function confirmUpdateRestart(win: BaseWindow | null): Promise<RestartDecision> {
  const answer = await runQuitConfirmation(win, 'update', true);
  if (answer === null) return { proceed: true, continueSessionIds: [] };
  return { proceed: answer.quit, continueSessionIds: answer.quit ? answer.continueSessionIds : [] };
}
