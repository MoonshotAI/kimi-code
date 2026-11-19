import { createRenderer, defineComponent, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { openBrowserOverlayDialogCount } from '../../src/renderer/lib/browserOverlayDialog';
import { browserPermissionRequests, observeBrowserPermissions, useBrowserPermissionDialog } from '../../src/renderer/lib/browserPermissions';

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const request = { requestId: 'permission-1', browserId: 'browser-1', origin: 'https://example.com', permissions: ['location' as const] };
afterEach(() => { browserPermissionRequests.value = []; vi.unstubAllGlobals(); });

it('shows a scoped keyboard-focused prompt, retains hidden requests, and routes explicit choices', async () => {
  const show = vi.fn(), close = vi.fn(), resolve = vi.fn(async () => true);
  let action: ((value: any) => void) | undefined;
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), kimiDesktop: {
    browserGetPermissionRequests: async () => [], browserResolvePermissionRequest: resolve,
    onBrowserOverlayClosed: () => () => {}, onBrowserOverlayDialogClosed: () => () => {},
    onBrowserOverlayDialogAction: (cb: typeof action) => { action = cb; return () => {}; },
    browserOverlayOpenDialog: show, browserOverlayCloseDialog: close,
  } });
  const visible = ref(false);
  const viewport = ref({ getBoundingClientRect: () => ({ x: 600, y: 100, width: 400, height: 600 }) });
  const app = renderer.createApp(defineComponent(() => { useBrowserPermissionDialog('browser-1', () => visible.value, viewport as any, key => key); return () => null; }));
  app.mount({});
  browserPermissionRequests.value = [request];
  await nextTick();
  expect(show).not.toHaveBeenCalled();
  visible.value = true;
  await nextTick();
  expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: request.requestId, preserveFocus: false, dismissible: false, boundary: { x: 600, y: 100, width: 400, height: 600 } }));
  expect(openBrowserOverlayDialogCount.value).toBe(1);
  visible.value = false;
  await nextTick();
  expect(close).toHaveBeenCalledWith(request.requestId);
  expect(openBrowserOverlayDialogCount.value).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
  expect(browserPermissionRequests.value).toHaveLength(1);
  visible.value = true;
  await nextTick();
  action!({ dialogId: 'other', action: 'confirm' });
  expect(resolve).not.toHaveBeenCalled();
  action!({ dialogId: request.requestId, action: 'auxiliary' });
  expect(resolve).toHaveBeenCalledWith({ requestId: request.requestId, decision: 'allow-always' });
  expect(openBrowserOverlayDialogCount.value).toBe(1);
  app.unmount();
  expect(openBrowserOverlayDialogCount.value).toBe(0);
});

it('does not overwrite a live permission update with a stale initial snapshot', async () => {
  let deliver: ((value: typeof request[]) => void) | undefined;
  let finish!: (value: typeof request[]) => void;
  vi.stubGlobal('window', { kimiDesktop: {
    browserGetPermissionRequests: () => new Promise<typeof request[]>(resolve => { finish = resolve; }),
    onBrowserPermissionRequests: (cb: typeof deliver) => { deliver = cb; return () => {}; },
  } });
  const stop = observeBrowserPermissions();
  deliver!([request]);
  finish([]);
  await Promise.resolve();
  expect(browserPermissionRequests.value).toHaveLength(1);
  stop();
});

it('lets a blocking alert or confirm take over the panel from a pending permission prompt', async () => {
  const { browserPageDialogPreemptsPermission, browserPageDialogs, useBrowserPageDialog } = await import('../../src/renderer/lib/browserPageDialogs');
  const show = vi.fn(), close = vi.fn();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), kimiDesktop: {
    browserGetPermissionRequests: async () => [], browserResolvePermissionRequest: vi.fn(async () => true),
    browserGetPageDialogs: async () => [], browserAnswerPageDialog: vi.fn(async () => true),
    onBrowserOverlayClosed: () => () => {}, onBrowserOverlayDialogClosed: () => () => {}, onBrowserOverlayDialogAction: () => () => {},
    browserOverlayOpenDialog: show, browserOverlayCloseDialog: close,
  } });
  const viewport = ref({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 600 }) });
  const app = renderer.createApp(defineComponent(() => {
    useBrowserPermissionDialog('browser-1', () => true, viewport as any, key => key, () => 'en', () => browserPageDialogPreemptsPermission(browserPageDialogs.value, 'browser-1'));
    useBrowserPageDialog('browser-1', () => true, viewport as any, key => key);
    return () => null;
  }));
  try {
    app.mount({});
    browserPermissionRequests.value = [request];
    await nextTick();
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: request.requestId }));
    for (const kind of ['alert', 'confirm'] as const) {
      show.mockClear();
      close.mockClear();
      browserPageDialogs.value = [{ dialogId: `${kind}-1`, browserId: 'browser-1', kind, origin: 'https://example.com', message: 'Saved?', answerer: 'user' }];
      await nextTick();
      expect(show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dialogId: `${kind}-1` }));
      expect(close).toHaveBeenCalledWith(request.requestId);
      show.mockClear();
      browserPageDialogs.value = [];
      await nextTick();
      expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: request.requestId }));
    }
    show.mockClear();
    browserPageDialogs.value = [{ dialogId: 'file-1', browserId: 'browser-1', kind: 'file', origin: 'https://example.com', message: '', answerer: 'user' }];
    await nextTick();
    expect(show).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    browserPageDialogs.value = [];
  }
});

it('keeps focus in the app UI unless the browser page had it, and always for agent-answered dialogs', async () => {
  const { browserPageDialogs, useBrowserPageDialog } = await import('../../src/renderer/lib/browserPageDialogs');
  const show = vi.fn();
  let appFocused = true;
  vi.stubGlobal('document', { hasFocus: () => appFocused });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), kimiDesktop: {
    browserGetPermissionRequests: async () => [], browserResolvePermissionRequest: vi.fn(async () => true),
    browserGetPageDialogs: async () => [], browserAnswerPageDialog: vi.fn(async () => true),
    onBrowserOverlayClosed: () => () => {}, onBrowserOverlayDialogClosed: () => () => {}, onBrowserOverlayDialogAction: () => () => {},
    browserOverlayOpenDialog: show, browserOverlayCloseDialog: vi.fn(),
  } });
  const viewport = ref({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 600 }) });
  const app = renderer.createApp(defineComponent(() => {
    useBrowserPermissionDialog('browser-1', () => true, viewport as any, key => key);
    useBrowserPageDialog('browser-2', () => true, viewport as any, key => key);
    return () => null;
  }));
  const confirm = { browserId: 'browser-2', kind: 'confirm' as const, origin: 'https://example.com', message: 'Leave?' };
  try {
    app.mount({});
    for (const focused of [true, false]) {
      appFocused = focused;
      browserPermissionRequests.value = [{ ...request, requestId: `permission-${focused}` }];
      browserPageDialogs.value = [{ ...confirm, dialogId: `user-${focused}`, answerer: 'user' }];
      await nextTick();
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ dialogId: `permission-${focused}`, preserveFocus: focused }));
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ dialogId: `user-${focused}`, preserveFocus: focused }));
    }
    browserPageDialogs.value = [{ ...confirm, dialogId: 'agent-1', answerer: 'agent' }];
    await nextTick();
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: 'agent-1', preserveFocus: true }));
  } finally {
    app.unmount();
    browserPageDialogs.value = [];
  }
});
