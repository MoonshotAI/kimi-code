// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScreenshotGuidanceDialog from '../../src/renderer/components/dialogs/ScreenshotGuidanceDialog.vue';
import type { ScreenshotGuidance } from '../../src/shared/screenshot-guidance';

let app: App;
let host: HTMLDivElement;
let receive: (guide: ScreenshotGuidance | null) => void;
const unsubscribe = vi.fn();
const action = vi.fn();
const getGuide = vi.fn();
const frames: FrameRequestCallback[] = [];
const initial: ScreenshotGuidance = {
  captureId: 'capture-id', locale: 'zh', platform: 'darwin', appName: 'Kimi Code Preview',
  kind: 'permission', phase: 'idle', canRequest: false, canRevealApp: true,
  settingsOpened: false, notice: 'none', reason: 'screen-access:denied',
};

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick();
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(async () => {
  vi.clearAllMocks();
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  action.mockResolvedValue(undefined);
  getGuide.mockResolvedValue({ ...initial });
  Object.assign(window, { kimiDesktop: {
    onScreenshotGuidance: (callback: typeof receive) => { receive = callback; return unsubscribe; },
    getScreenshotGuidance: getGuide, screenshotGuidanceAction: action,
  } });
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ScreenshotGuidanceDialog);
  app.mount(host);
  await flush();
});

afterEach(() => {
  app.unmount();
  host.remove();
  Reflect.deleteProperty(window, 'kimiDesktop');
  vi.unstubAllGlobals();
});

describe('screenshot guidance', () => {
  it.each(['zh', 'en'] as const)('omits technical errors and the audio hint in %s', async (locale) => {
    receive({ ...initial, locale });
    await flush();
    for (const text of ['screen-access:denied', '错误详情', 'Error details', '仅用于截图，不录制音频', 'Used for screenshots only. No audio recorded']) {
      expect(document.body.textContent).not.toContain(text);
    }
    button(locale === 'zh' ? '遇到问题' : 'Get help').click();
    await flush();
    expect(document.querySelector('.screenshot-guide details')).toBeNull();
    expect(document.body.textContent).not.toContain('screen-access:denied');
    expect(document.body.textContent).not.toContain(locale === 'zh' ? '错误详情' : 'Error details');
  });

  it('shows a compact introduction with one primary action and keeps troubleshooting out of the first screen', async () => {
    expect(document.body.textContent).toContain('Kimi Code Preview');
    expect(document.body.textContent).not.toContain('隐私与安全性');
    expect(document.body.textContent).not.toContain('错误详情');
    expect(document.querySelector('.screenshot-guide__steps')).toBeNull();
    expect(document.querySelectorAll('.ui-dialog__foot button')).toHaveLength(2);
    expect(document.querySelectorAll('.ui-button--primary')).toHaveLength(1);
    button('打开系统设置').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'settings');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    receive({ ...initial, settingsOpened: true, notice: 'settings-failed' });
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('设置路径');
    button('检查权限').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'check');
  });

  it('offers requesting access only for first use', async () => {
    receive({ ...initial, canRequest: true });
    await flush();
    button('开启权限').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'request');
    expect([...document.querySelectorAll('button')].some((el) => el.textContent === '重启应用')).toBe(false);
  });

  it('requires explicit restart confirmation with the interruption warning', async () => {
    button('遇到问题').click();
    await flush();
    button('重启应用').click();
    await flush();
    expect(action).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('中断正在运行的任务和终端');
    button('返回').click();
    await flush();
    expect(action).not.toHaveBeenCalled();
    button('重启应用').click();
    await flush();
    button('重启应用').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'restart');
  });

  it('removes the guide and allows painting before continuing capture', async () => {
    receive({ ...initial, phase: 'ready' });
    await flush();
    button('继续截图').click();
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(action).not.toHaveBeenCalled();
    frames.shift()!(0);
    frames.shift()!(16);
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'continue');
  });

  it('cancels with the first Escape but ignores composing Escape', async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }));
    expect(action).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'cancel');
  });

  it('shows Windows recovery without macOS permission controls', async () => {
    receive({ ...initial, platform: 'win32', kind: 'capture', canRevealApp: false });
    await flush();
    expect(document.body.textContent).toContain('Win + Shift + S');
    expect(document.body.textContent).not.toContain('隐私与安全性');
    expect(document.body.textContent).not.toContain('重启应用');
    button('重试').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'check');
  });

  it('disables repeated checks while remaining cancellable', async () => {
    receive({ ...initial, phase: 'checking' });
    await flush();
    expect(button('正在检查…').disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('.ui-dialog__close')!.click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'cancel');
  });

  it('does not let an initial snapshot overwrite a newer event', async () => {
    app.unmount();
    let resolve!: (guide: ScreenshotGuidance) => void;
    getGuide.mockReturnValue(new Promise<ScreenshotGuidance>((done) => { resolve = done; }));
    app = createApp(ScreenshotGuidanceDialog);
    app.mount(host);
    receive({ ...initial, phase: 'ready' });
    resolve(initial);
    await flush();
    expect(button('继续截图')).toBeDefined();
  });

  it('keeps a rejected action visible and recoverable', async () => {
    action.mockRejectedValueOnce(new Error('IPC unavailable'));
    button('打开系统设置').click();
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('操作未完成');
    expect(button('打开系统设置').disabled).toBe(false);
  });

  it('shows settings and recovery only on the help screen and can return without canceling', async () => {
    button('遇到问题').click();
    await flush();
    expect(document.body.textContent).toContain('隐私与安全性');
    expect(document.body.textContent).not.toContain('错误详情');
    button('在 Finder 中显示应用').click();
    await flush();
    expect(action).toHaveBeenCalledWith('capture-id', 'reveal');
    button('返回').click();
    await flush();
    expect(document.body.textContent).not.toContain('隐私与安全性');
    expect(action).not.toHaveBeenCalledWith('capture-id', 'cancel');
    receive({ ...initial, phase: 'ready' });
    await flush();
    expect(document.querySelectorAll('.ui-dialog__foot button')).toHaveLength(1);
    expect(button('继续截图')).toBeDefined();
  });

  it('resets help when a new capture starts and keeps restricted access free of recovery actions', async () => {
    button('遇到问题').click();
    await flush();
    receive({ ...initial, captureId: 'next-capture' });
    await flush();
    expect(document.body.textContent).not.toContain('隐私与安全性');
    receive({ ...initial, captureId: 'restricted-capture', kind: 'restricted' });
    await flush();
    expect(document.body.textContent).toContain('设备管理员');
    expect(document.querySelectorAll('.ui-dialog__foot button')).toHaveLength(1);
    button('关闭').click();
    await flush();
    expect(action).toHaveBeenCalledWith('restricted-capture', 'cancel');
  });
});
