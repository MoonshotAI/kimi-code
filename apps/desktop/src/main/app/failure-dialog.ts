import { app, clipboard, dialog } from 'electron';
import type { DesktopFailureKind } from '../../shared/failure-feedback';
import { log } from '../diagnostics/log';
import { getRuntimeLocale } from '../diagnostics/track';

interface FailureDialogCopy {
  title: string;
  detail: string;
  ok: string;
  copyLink?: string;
}

type FailureToastSender = (kind: DesktopFailureKind, url?: string) => boolean;
let sendFailureToast: FailureToastSender = () => false;

export function setFailureToastSender(sender: FailureToastSender): void {
  sendFailureToast = sender;
}

export function showFailureFeedback(kind: DesktopFailureKind, zh: FailureDialogCopy, en: FailureDialogCopy, url?: string): void {
  try {
    if (sendFailureToast(kind, url)) return;
  } catch (error) {
    log.warn(`[kimi-desktop] failure toast failed: ${String(error)}`);
  }
  showFailureDialog(zh, en, url);
}

export function showFailureDialog(zh: FailureDialogCopy, en: FailureDialogCopy, url?: string): void {
  try {
    const runtimeLocale = getRuntimeLocale();
    const copy = runtimeLocale === 'zh' ? zh : runtimeLocale === 'en' ? en : app.getLocale().toLowerCase().startsWith('zh') ? zh : en;
    const copyLink = url !== undefined && copy.copyLink !== undefined ? { label: copy.copyLink, url } : undefined;
    void dialog.showMessageBox({
      type: 'warning',
      title: copy.title,
      message: copy.title,
      detail: copy.detail,
      buttons: copyLink === undefined ? [copy.ok] : [copy.ok, copyLink.label],
      defaultId: 0,
      noLink: true,
    }).then(async ({ response }) => {
      if (copyLink !== undefined && response === 1) await clipboard.writeText(copyLink.url);
    }).catch((error: unknown) => {
      log.warn(`[kimi-desktop] failure dialog failed: ${String(error)}`);
    });
  } catch (error) {
    log.warn(`[kimi-desktop] failure dialog failed: ${String(error)}`);
  }
}
