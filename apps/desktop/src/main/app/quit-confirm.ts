import { app, dialog } from 'electron';
import type { BaseWindow, MessageBoxOptions } from 'electron';

import { embeddedServerOrigin } from '../server/connect';
import { desktopServerSecret } from '../server/server-auth';
import { IPC } from '../ipc/ipc-channels';
import { log } from '../diagnostics/log';
import { trackDesktopEvent } from '../diagnostics/track';
import { setRemoteControlPreviousEnabled } from './ui-state';
import type { TrayLocale } from '../shell/tray';
import { addMainWindowCloseInterceptor, isQuitConfirmSkipped, isRendererReady, onMainWindowGone, sendToRenderer, showMainWindow } from '../window/main-window';

const BUSY_SESSIONS_QUERY_TIMEOUT_MS = 1_500;

export type QuitBlockReason = 'busy' | 'remote-control';

interface QuitConfirmStrings {
  title: string;
  detail: string;
  detailRemoteControl: string;
  detailBoth: string;
  cancel: string;
  quit: string;
}

const QUIT_CONFIRM_STRINGS: Record<TrayLocale, QuitConfirmStrings> = {
  zh: {
    title: '退出 Kimi Code？',
    detail: '还有会话在进行，退出会中断它们。',
    detailRemoteControl: '远程控制正在运行，退出客户端会停止远程控制',
    detailBoth: '还有会话在进行，退出会中断它们；远程控制正在运行，退出客户端会停止远程控制',
    cancel: '取消',
    quit: '退出',
  },
  en: {
    title: 'Quit Kimi Code?',
    detail: 'Sessions are still in progress on this machine and will be interrupted if you quit.',
    detailRemoteControl: 'Remote Control is running. Quitting the app will stop it',
    detailBoth:
      'Sessions are still in progress and will be interrupted. Remote Control is also running — quitting the app will stop it',
    cancel: 'Cancel',
    quit: 'Quit',
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

async function queryQuitBlockReasons(
  origin: string,
  token: string | undefined,
): Promise<QuitBlockReason[]> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  const request = async (url: string): Promise<unknown> => {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(BUSY_SESSIONS_QUERY_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch (error) {
      log.warn(
        `[kimi-desktop] quit confirmation: quit-block query failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
  };
  const [busyPayload, remoteControlPayload] = await Promise.all([
    request(busySessionsUrl(origin)),
    request(remoteControlStatusUrl(origin)),
  ]);
  const reasons: QuitBlockReason[] = [];
  if (hasBusySession(busyPayload)) reasons.push('busy');
  const remoteControl = parseRemoteControlEnabled(remoteControlPayload);
  if (remoteControl !== undefined) {
    setRemoteControlPreviousEnabled(remoteControl);
    if (remoteControl) reasons.push('remote-control');
  }
  return reasons;
}

export type QuitConfirmChoice = 'quit' | 'cancel' | 'unavailable';

let pendingQuitConfirmResolve: ((choice: QuitConfirmChoice) => void) | null = null;
let pendingQuitConfirmRequestId: number | null = null;
let quitConfirmRequestSeq = 0;
let activeQuitChecks = 0;

export function resolveQuitConfirmResponse(choice: QuitConfirmChoice, requestId?: number): void {
  if (requestId !== undefined && requestId !== pendingQuitConfirmRequestId) return;
  const resolve = pendingQuitConfirmResolve;
  pendingQuitConfirmResolve = null;
  pendingQuitConfirmRequestId = null;
  resolve?.(choice);
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

function confirmQuitInApp(win: BaseWindow, reasons: QuitBlockReason[]): Promise<boolean | null> {
  return new Promise<boolean | null>((resolve) => {
    const requestId = ++quitConfirmRequestSeq;
    pendingQuitConfirmResolve = (choice) => {
      if (choice === 'unavailable') {
        sendToRenderer(IPC.quitConfirmCancel, requestId);
        log.warn('[kimi-desktop] quit confirmation: renderer unavailable, falling back to native dialog');
        void confirmQuitNative(win, reasons).then(resolve);
        return;
      }
      resolve(choice === 'quit');
    };
    pendingQuitConfirmRequestId = requestId;
    showMainWindow();
    sendToRenderer(IPC.quitConfirm, requestId, reasons);
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

async function confirmQuitNative(
  win: BaseWindow | null,
  reasons: QuitBlockReason[],
): Promise<boolean | null> {
  const locale = effectiveQuitConfirmLocale();
  const strings = quitConfirmStrings(locale);
  const options: MessageBoxOptions = {
    type: 'warning',
    message: strings.title,
    detail: quitConfirmDetail(locale, reasons),
    buttons: [strings.cancel, strings.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  try {
    const { response } =
      win !== null && !win.isDestroyed() && win.isVisible()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return response === 1;
  } catch (error) {
    log.warn(`[kimi-desktop] quit confirmation skipped: dialog failed (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

export async function shouldBlockQuit(
  win: BaseWindow | null,
  options: { interceptWindowClose?: boolean } = {},
): Promise<boolean> {
  const origin = embeddedServerOrigin();
  if (origin === null) return false;
  const interceptWindowClose = options.interceptWindowClose ?? true;
  if (interceptWindowClose) activeQuitChecks += 1;
  try {
    const reasons = await queryQuitBlockReasons(origin, desktopServerSecret());
    if (reasons.length === 0) return false;
    const quit = await enqueueQuitConfirm(() => {
      trackQuitConfirmation('shown');
      return win !== null && !win.isDestroyed() && isRendererReady()
        ? confirmQuitInApp(win, reasons)
        : confirmQuitNative(win, reasons);
    });
    if (quit === null) return false;
    trackQuitConfirmation(quit ? 'quit' : 'cancel');
    return !quit;
  } finally {
    if (interceptWindowClose) activeQuitChecks -= 1;
  }
}
