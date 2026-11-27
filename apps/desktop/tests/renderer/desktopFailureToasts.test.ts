import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { DesktopFailureKind } from '../../src/shared/failure-feedback';
import { desktopFailureNotice, observeDesktopFailureToasts } from '../../src/renderer/lib/desktopFailureToasts';

const url = 'https://example.com/docs?token=secret';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop failure toasts', () => {
  it('uses the current renderer locale for both failure kinds', () => {
    const i18n = createKimiI18n({ locale: 'zh' });
    expect(desktopFailureNotice('external-link', i18n.global.t, url)).toEqual({
      severity: 'warning',
      title: '无法打开链接',
      message: '系统未能调起浏览器，请复制链接后手动打开',
      copyLink: { label: '复制链接', copiedLabel: '已复制链接', url },
    });
    expect(desktopFailureNotice('screenshot-save', i18n.global.t)).toEqual({
      severity: 'warning',
      title: '无法保存截图',
      message: '请选择其他保存位置后重试',
    });
    i18n.global.locale.value = 'en';
    expect(desktopFailureNotice('external-link', i18n.global.t, url)).toEqual({
      severity: 'warning',
      title: "Couldn't open link",
      message: "Couldn't open your browser. Copy the link and open it manually",
      copyLink: { label: 'Copy link', copiedLabel: 'Link copied', url },
    });
    expect(desktopFailureNotice('screenshot-save', i18n.global.t)).toEqual({
      severity: 'warning',
      title: "Couldn't save screenshot",
      message: 'Choose another location and try again',
    });
  });

  it('notifies through the existing warning toast pipeline and unsubscribes', () => {
    let listener: ((kind: DesktopFailureKind, url?: string) => void) | undefined;
    const offBridge = vi.fn();
    vi.stubGlobal('window', {
      kimiDesktop: {
        onFailureToast: (cb: (kind: DesktopFailureKind, url?: string) => void) => {
          listener = cb;
          return offBridge;
        },
      },
    });
    const notify = vi.fn();
    const i18n = createKimiI18n({ locale: 'en' });
    const off = observeDesktopFailureToasts(notify, i18n.global.t);
    listener?.('external-link', url);
    expect(notify).toHaveBeenCalledWith({
      severity: 'warning',
      title: "Couldn't open link",
      message: "Couldn't open your browser. Copy the link and open it manually",
      copyLink: { label: 'Copy link', copiedLabel: 'Link copied', url },
    });
    off();
    expect(offBridge).toHaveBeenCalledOnce();
  });
});
