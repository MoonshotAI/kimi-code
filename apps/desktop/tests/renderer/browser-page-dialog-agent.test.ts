// @vitest-environment jsdom
import { createApp, defineComponent, nextTick, ref, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import BrowserOverlayMenu from '../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue';
import { registerBrowserOverlayDialog } from '../../src/renderer/lib/browserOverlayDialog';
import { activeBrowserPageDialog, browserApprovalBrowserIds, browserPageDialogContent, browserPageDialogs, useBrowserPageDialog } from '../../src/renderer/lib/browserPageDialogs';
import { asBrowserOverlayDialogRequest, type BrowserOverlayConfig, type BrowserOverlayDialogAction } from '../../src/shared/browser-overlay';
import type { BrowserPageDialog } from '../../src/shared/browser-dialogs';

const i18n = createKimiI18n({ locale: 'en' });
const t = (key: string, params?: Record<string, string>) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));
const dialog = (patch: Partial<BrowserPageDialog>): BrowserPageDialog => ({ dialogId: 'dialog-1', browserId: 'browser-1', kind: 'alert', origin: 'https://example.test', message: 'Saved!', answerer: 'agent', ...patch });

describe('page dialog content', () => {
  it('reminds the user of every dialog only the user can answer', () => {
    browserPageDialogs.value = [
      dialog({ dialogId: 'agent-alert', browserId: 'agent' }),
      dialog({ dialogId: 'chosen', browserId: 'chosen', answerer: 'user', agentChoice: 'accepted' }),
      ...(['alert', 'confirm', 'beforeunload', 'file', 'upload', 'download'] as const).map(kind => dialog({ dialogId: kind, browserId: `user-${kind}`, kind, answerer: 'user' })),
    ];
    try {
      expect(browserApprovalBrowserIds.value).toEqual(['user-alert', 'user-confirm', 'user-beforeunload', 'user-file', 'user-upload']);
    } finally { browserPageDialogs.value = []; }
  });

  it('shows a pending upload approval ahead of the file dialog it answers', () => {
    const file = dialog({ dialogId: 'file-1', kind: 'file' });
    const upload = dialog({ dialogId: 'upload-1', kind: 'upload', answerer: 'user', files: ['/Users/me/id.png'] });
    const other = dialog({ dialogId: 'other-1', browserId: 'browser-2', kind: 'upload' });
    expect(activeBrowserPageDialog([other, file, upload], 'browser-1')).toBe(upload);
    expect(activeBrowserPageDialog([file], 'browser-1')).toBe(file);
    expect(activeBrowserPageDialog([other], 'browser-1')).toBeUndefined();
  });

  it('shows a page-blocking dialog ahead of a pending file or upload dialog', () => {
    const file = dialog({ dialogId: 'file-1', kind: 'file' });
    const upload = dialog({ dialogId: 'upload-1', kind: 'upload', answerer: 'user', files: ['/Users/me/id.png'] });
    for (const kind of ['alert', 'confirm', 'beforeunload'] as const) {
      const blocking = dialog({ dialogId: `${kind}-1`, kind });
      expect(activeBrowserPageDialog([file, upload, blocking], 'browser-1')).toBe(blocking);
    }
  });

  it('shows a blocking alert or confirm ahead of an earlier beforeunload, then upload, then file', () => {
    const file = dialog({ dialogId: 'file-1', kind: 'file' });
    const upload = dialog({ dialogId: 'upload-1', kind: 'upload', answerer: 'user', files: ['/Users/me/id.png'] });
    const leave = dialog({ dialogId: 'leave-1', kind: 'beforeunload' });
    const download = dialog({ dialogId: 'download-1', kind: 'download' });
    for (const kind of ['alert', 'confirm'] as const) {
      const blocking = dialog({ dialogId: `${kind}-1`, kind });
      expect(activeBrowserPageDialog([download, file, upload, leave, blocking], 'browser-1')).toBe(blocking);
    }
    expect(activeBrowserPageDialog([download, file, upload, leave], 'browser-1')).toBe(leave);
    expect(activeBrowserPageDialog([download, file, upload], 'browser-1')).toBe(upload);
    expect(activeBrowserPageDialog([download, file], 'browser-1')).toBe(file);
    expect(activeBrowserPageDialog([download], 'browser-1')).toBe(download);
  });

  it('shows only the page text and marks agent-answerable dialogs with the agent tab', () => {
    for (const kind of ['alert', 'confirm'] as const) {
      const content = browserPageDialogContent(dialog({ kind, message: 'Delete this?\nIt cannot be undone.' }), t);
      expect(content.message).toBe('Delete this?\nIt cannot be undone.');
      expect(content.agent).toEqual({ label: 'Agent in control', hint: 'The agent can answer this. You can also answer it yourself.' });
    }
    expect(browserPageDialogContent(dialog({ answerer: 'user' }), t).agent).toBeUndefined();
    const leave = browserPageDialogContent(dialog({ kind: 'beforeunload', message: '' }), t);
    expect(leave.message).not.toContain('agent');
    expect(leave.agent?.label).toBe('Agent in control');
    const upload = browserPageDialogContent(dialog({ kind: 'upload', answerer: 'user', files: ['/Users/me/very/long/path/to/Documents/report-final-v2.pdf'] }), t);
    expect(upload.agent?.label).toBe('Agent in control');
  });

  it('lists every upload path for approval even when their text exceeds the message limit', () => {
    const files = Array.from({ length: 32 }, (_, index) => `/Users/me/${'nested/'.repeat(30)}secret-${index}.pem`);
    expect(files.join('\n').length).toBeGreaterThan(4096);
    const content = browserPageDialogContent(dialog({ kind: 'upload', answerer: 'user', files }), t);
    expect(content.files).toEqual(files);
    expect(content.message).toBe('Upload the following files (32) to https://example.test?');
    expect(content.message).not.toContain('secret-');
    expect(asBrowserOverlayDialogRequest({ dialogId: 'dialog-1', ...content })?.files).toEqual(files);
    expect(asBrowserOverlayDialogRequest({ dialogId: 'dialog-1', ...content, files: [...files, '/extra'] })).toBeNull();
    const zh = createKimiI18n({ locale: 'zh' });
    const tz = (key: string, params?: Record<string, string>) => (params === undefined ? zh.global.t(key) : zh.global.t(key, params));
    expect(browserPageDialogContent(dialog({ kind: 'upload', answerer: 'user', files }), tz).message).toBe('要将以下文件（共 32 个）上传到 https://example.test 吗？');
  });

  it('asks the user to repeat a form submission or an unknown navigation after leaving', () => {
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', message: '', repeat: 'form' }), t).message).toBe('https://example.test\nChanges you made may not be saved\nThis page was submitting a form. After you choose Leave, submit it again.');
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', message: '', repeat: 'action' }), t).message).toContain('\nThis page stays open. After you choose Leave, repeat the action that leaves it.');
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', message: '', target: 'https://example.test/next' }), t).message).not.toContain('After you choose Leave');
    const zh = createKimiI18n({ locale: 'zh' });
    const tz = (key: string, params?: Record<string, string>) => (params === undefined ? zh.global.t(key) : zh.global.t(key, params));
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', message: '', repeat: 'form' }), tz).message).toContain('\n此页面正在提交表单。选择离开后，请重新提交。');
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', message: '', repeat: 'action' }), tz).message).toContain('\n此页面会保持打开。选择离开后，请重新执行离开此页面的操作。');
  });

  it('uses the Chinese tab labels', () => {
    const zh = createKimiI18n({ locale: 'zh' });
    const tz = (key: string, params?: Record<string, string>) => (params === undefined ? zh.global.t(key) : zh.global.t(key, params));
    expect(browserPageDialogContent(dialog({ kind: 'alert' }), tz).agent?.label).toBe('智能体操控中');
    expect(browserPageDialogContent(dialog({ kind: 'confirm', agentChoice: 'accepted' }), tz).agent?.label).toBe('智能体选择了“确定”');
  });

  it('gives alert a single OK button', () => {
    const content = browserPageDialogContent(dialog({ kind: 'alert' }), t);
    expect(content).toMatchObject({ confirmLabel: 'OK', singleAction: true });
    expect(browserPageDialogContent(dialog({ kind: 'confirm' }), t).singleAction).toBeUndefined();
  });

  it('shows the agent choice before the dialog closes', () => {
    expect(browserPageDialogContent(dialog({ kind: 'alert', agentChoice: 'accepted' }), t).agent).toMatchObject({ label: 'Agent chose OK', chosen: true });
    expect(browserPageDialogContent(dialog({ kind: 'confirm', agentChoice: 'dismissed' }), t).agent).toMatchObject({ label: 'Agent chose Cancel', chosen: true });
    expect(browserPageDialogContent(dialog({ kind: 'beforeunload', agentChoice: 'accepted' }), t).agent?.label).toBe('Agent chose Leave');
  });

  it('passes the agent tab and single action through the overlay validator', () => {
    const content = browserPageDialogContent(dialog({ kind: 'alert' }), t);
    expect(asBrowserOverlayDialogRequest({ dialogId: 'dialog-1', ...content })).toMatchObject({ agent: content.agent, singleAction: true });
    expect(asBrowserOverlayDialogRequest({ dialogId: 'dialog-1', ...content, agent: { label: 'x', hint: 'y', extra: 1 } })).toBeNull();
  });

  it('asks for prompt text in a single-line field filled with the page default', () => {
    const content = browserPageDialogContent(dialog({ kind: 'prompt', message: 'Name?', defaultValue: 'Ada' }), t);
    expect(content).toMatchObject({ title: 'https://example.test says', message: 'Name?', input: { label: 'Text for the page', value: 'Ada', singleLine: true }, confirmLabel: 'OK', cancelLabel: 'Cancel', dismissible: false, agent: { label: 'Agent in control' } });
    expect(asBrowserOverlayDialogRequest({ dialogId: 'dialog-1', ...content })).toMatchObject({ input: { value: 'Ada', singleLine: true } });
    const tz = (key: string, params?: Record<string, string>) => createKimiI18n({ locale: 'zh' }).global.t(key, params ?? {});
    expect(browserPageDialogContent(dialog({ kind: 'prompt' }), tz).input?.label).toBe('提供给网页的文本');
    expect(activeBrowserPageDialog([dialog({ dialogId: 'leave', kind: 'beforeunload' }), dialog({ dialogId: 'prompt', kind: 'prompt' })], 'browser-1')?.dialogId).toBe('prompt');
  });

  it('answers a prompt with the typed text and a cancel without text', async () => {
    let action!: (payload: BrowserOverlayDialogAction) => void;
    const answer = vi.fn(async () => true);
    (window as { kimiDesktop?: unknown }).kimiDesktop = {
      browserGetPageDialogs: async () => [], browserAnswerPageDialog: answer, onBrowserPageDialogs: () => () => {},
      browserOverlayOpenDialog: vi.fn(), browserOverlayCloseDialog: vi.fn(), onBrowserOverlayClosed: () => () => {}, onBrowserOverlayDialogClosed: () => () => {},
      onBrowserOverlayDialogAction: (cb: typeof action) => { action = cb; return () => {}; },
    };
    const viewport = ref({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 600 }) });
    const app = createApp(defineComponent(() => { useBrowserPageDialog('browser-1', () => true, viewport as never, t); return () => null; }));
    app.mount(document.createElement('div'));
    try {
      browserPageDialogs.value = [dialog({ dialogId: 'prompt-1', kind: 'prompt', defaultValue: 'Ada', answerer: 'user' })];
      await nextTick();
      action({ dialogId: 'prompt-1', action: 'confirm', value: 'Grace' });
      expect(answer).toHaveBeenLastCalledWith({ dialogId: 'prompt-1', accept: true, text: 'Grace' });
      browserPageDialogs.value = [dialog({ dialogId: 'prompt-2', kind: 'prompt', defaultValue: 'Ada', answerer: 'user' })];
      await nextTick();
      action({ dialogId: 'prompt-2', action: 'cancel', value: 'Grace' });
      expect(answer).toHaveBeenLastCalledWith({ dialogId: 'prompt-2', accept: false });
    } finally {
      app.unmount();
      browserPageDialogs.value = [];
      delete (window as { kimiDesktop?: unknown }).kimiDesktop;
    }
  });
});

describe('page dialog and app dialogs on the shared overlay', () => {
  function fakeSurface() {
    let current: string | null = null;
    const closedListeners: ((event: { dialogId: string; reason: string }) => void)[] = [];
    const emitClosed = (dialogId: string, reason: string) => closedListeners.forEach(cb => cb({ dialogId, reason }));
    const open = vi.fn((request: { dialogId: string }) => {
      if (current !== null && current !== request.dialogId) { const old = current; current = request.dialogId; emitClosed(old, 'replaced'); return; }
      current = request.dialogId;
    });
    const close = vi.fn((dialogId: string) => { if (current === dialogId) current = null; });
    (window as { kimiDesktop?: unknown }).kimiDesktop = {
      browserGetPageDialogs: async () => [], browserAnswerPageDialog: vi.fn(async () => true), onBrowserPageDialogs: () => () => {},
      browserOverlayOpenDialog: open, browserOverlayCloseDialog: close, onBrowserOverlayClosed: () => () => {},
      onBrowserOverlayDialogClosed: (cb: (event: { dialogId: string; reason: string }) => void) => { closedListeners.push(cb); return () => {}; },
      onBrowserOverlayDialogAction: () => () => {},
    };
    return { current: () => current, open };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) { await Promise.resolve(); await nextTick(); }
  }

  function mountPage() {
    const viewport = ref({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 600 }) });
    const app = createApp(defineComponent(() => { useBrowserPageDialog('browser-1', () => true, viewport as never, t); return () => null; }));
    app.mount(document.createElement('div'));
    return app;
  }

  afterEach(() => { browserPageDialogs.value = []; delete (window as { kimiDesktop?: unknown }).kimiDesktop; });

  it('keeps a pending page dialog from replacing an open app confirm and shows it once the confirm closes', async () => {
    const surface = fakeSurface();
    const onCancel = vi.fn();
    const confirm = registerBrowserOverlayDialog({ id: 'global-confirm', onConfirm: vi.fn(), onCancel });
    confirm.show({ title: 'Delete session', confirmLabel: 'Delete', cancelLabel: 'Cancel', closeLabel: 'Close', variant: 'danger' }, '1');
    browserPageDialogs.value = [dialog({ dialogId: 'page-1', kind: 'confirm', answerer: 'user' })];
    const app = mountPage();
    try {
      await settle();
      window.dispatchEvent(new Event('focus'));
      await settle();
      expect(surface.current()).toBe('global-confirm:1');
      expect(onCancel).not.toHaveBeenCalled();
      confirm.close();
      await settle();
      expect(surface.current()).toBe('page-1');
    } finally {
      confirm.dispose();
      app.unmount();
    }
  });

  it('lets an app dialog opened by the user take over from a showing page dialog, then restores the page dialog', async () => {
    const surface = fakeSurface();
    browserPageDialogs.value = [dialog({ dialogId: 'page-1', kind: 'confirm', answerer: 'user' })];
    const app = mountPage();
    const onCancel = vi.fn();
    const confirm = registerBrowserOverlayDialog({ id: 'global-confirm', onConfirm: vi.fn(), onCancel });
    try {
      await settle();
      expect(surface.current()).toBe('page-1');
      confirm.show({ title: 'Delete session', confirmLabel: 'Delete', cancelLabel: 'Cancel', closeLabel: 'Close', variant: 'danger' }, '1');
      await settle();
      expect(surface.current()).toBe('global-confirm:1');
      expect(onCancel).not.toHaveBeenCalled();
      confirm.close();
      await settle();
      expect(surface.current()).toBe('page-1');
    } finally {
      confirm.dispose();
      app.unmount();
    }
  });
});

describe('overlay dialog', () => {
  let app: App | null = null;
  afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  let emit!: (config: BrowserOverlayConfig) => void;
  let shown!: (payload: { requestId: number }) => void;
  const submitForm = vi.fn();
  const dismiss = vi.fn();
  async function render(config: BrowserOverlayConfig, reducedMotion = false): Promise<HTMLElement> {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reducedMotion && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
    (window as { kimiBrowserOverlay?: unknown }).kimiBrowserOverlay = {
      ready() {}, rendered() {}, hidden() {}, activate: vi.fn(), submitForm, dismiss,
      onConfig: (cb: (config: BrowserOverlayConfig) => void) => { emit = cb; return () => {}; },
      onShown: (cb: typeof shown) => { shown = cb; return () => {}; }, onHide: () => () => {},
    };
    const host = document.createElement('div');
    document.body.append(host);
    app = createApp(BrowserOverlayMenu);
    app.mount(host);
    emit(config);
    await nextTick();
    await nextTick();
    return host;
  }

  it('renders the agent border, tab and one OK button for an alert, and wraps long paths', async () => {
    const content = browserPageDialogContent(dialog({ kind: 'alert', message: '/Users/me/Downloads/BaiduNetdisk_mac_8.8.8_arm64.dmg' }), t);
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...content });
    const section = host.querySelector('.browser-overlay-dialog')!;
    expect(section.classList.contains('is-agent')).toBe(true);
    expect(section.classList.contains('is-reduced-motion')).toBe(false);
    const tab = host.querySelector('.browser-overlay-dialog__agent-tab')!;
    expect(tab.textContent?.trim()).toBe('Agent in control');
    expect(tab.getAttribute('title')).toBe('The agent can answer this. You can also answer it yourself.');
    expect(tab.getAttribute('aria-label')).toContain('You can also answer it yourself.');
    expect(section.querySelector('.browser-overlay-dialog__body')?.textContent).not.toContain('Agent');
    expect(host.querySelector('.browser-overlay-dialog__cancel')).toBeNull();
    expect(host.querySelectorAll('.browser-overlay-dialog__foot button')).toHaveLength(1);
    expect(host.querySelector('.browser-overlay-dialog__body p')?.textContent).toBe('/Users/me/Downloads/BaiduNetdisk_mac_8.8.8_arm64.dmg');
  });

  it('renders every upload path as a labelled scrollable list', async () => {
    const files = Array.from({ length: 32 }, (_, index) => `/Users/me/${'nested/'.repeat(30)}secret-${index}.pem`);
    const content = browserPageDialogContent(dialog({ kind: 'upload', answerer: 'user', files }), t);
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...content });
    const list = host.querySelector('.browser-overlay-dialog__files')!;
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('tabindex')).toBe('0');
    const label = host.querySelector(`#${list.getAttribute('aria-labelledby')}`);
    expect(label?.textContent).toBe('Upload the following files (32) to https://example.test?');
    expect([...list.querySelectorAll('li')].map(item => item.textContent)).toEqual(files);
  });

  it('shows the agent choice on the tab', async () => {
    const content = browserPageDialogContent(dialog({ kind: 'beforeunload', agentChoice: 'accepted' }), t);
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...content });
    expect(host.querySelector('.browser-overlay-dialog__agent-tab')?.textContent?.trim()).toBe('Agent chose Leave');
  });

  it('drops the glow and tab when control ends', async () => {
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...browserPageDialogContent(dialog({ kind: 'confirm' }), t) });
    expect(host.querySelector('.browser-overlay-dialog__agent-tab')).not.toBeNull();
    emit({ kind: 'dialog', requestId: 2, dialogId: 'dialog-1', ...browserPageDialogContent(dialog({ kind: 'confirm', answerer: 'user' }), t) });
    await nextTick();
    const section = host.querySelector('.browser-overlay-dialog')!;
    expect(section.classList.contains('is-agent')).toBe(false);
    expect(section.classList.contains('is-reduced-motion')).toBe(false);
    expect(host.querySelector('.browser-overlay-dialog__agent-tab')).toBeNull();
  });

  it('focuses the prompt field with its default selected, submits on Enter and cancels on Escape', async () => {
    submitForm.mockClear();
    dismiss.mockClear();
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...browserPageDialogContent(dialog({ kind: 'prompt', message: 'Name?', defaultValue: 'Ada', answerer: 'user' }), t) });
    expect(host.querySelector('textarea')).toBeNull();
    const field = host.querySelector<HTMLInputElement>('input.ui-input')!;
    expect(field.value).toBe('Ada');
    expect(field.getAttribute('aria-label')).toBe('Text for the page');
    shown({ requestId: 1 });
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 3]);
    field.value = 'Grace';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submitForm).toHaveBeenLastCalledWith({ requestId: 1, action: 'confirm', value: 'Grace', checked: undefined });
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(submitForm).toHaveBeenLastCalledWith({ requestId: 1, action: 'cancel', value: 'Grace', checked: undefined });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('renders a plain dialog without the agent mark', async () => {
    const content = browserPageDialogContent(dialog({ kind: 'confirm', answerer: 'user' }), t);
    const host = await render({ kind: 'dialog', requestId: 1, dialogId: 'dialog-1', ...content });
    expect(host.querySelector('.browser-overlay-dialog')!.classList.contains('is-agent')).toBe(false);
    expect(host.querySelector('.browser-overlay-dialog__agent')).toBeNull();
    expect(host.querySelector('.browser-overlay-dialog__cancel')).not.toBeNull();
  });
});
