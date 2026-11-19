import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import type { BrowserPageDialog, BrowserPageDialogAnswer } from '../../shared/browser-dialogs';
import type { BrowserOverlayDialogAction, BrowserOverlayDialogRequest } from '../../shared/browser-overlay';
import { appUiHasFocus, browserOverlayAppDialogOpen } from './browserOverlayDialog';
import { browserPermissionRequests } from './browserPermissions';

interface PageDialogBridge {
  browserGetPageDialogs: () => Promise<BrowserPageDialog[]>;
  browserAnswerPageDialog: (answer: BrowserPageDialogAnswer) => Promise<boolean>;
  onBrowserPageDialogs: (cb: (dialogs: BrowserPageDialog[]) => void) => () => void;
  browserOverlayOpenDialog: (request: BrowserOverlayDialogRequest) => void;
  browserOverlayCloseDialog: (id: string) => void;
  onBrowserOverlayClosed: (cb: () => void) => () => void;
  onBrowserOverlayDialogClosed: (cb: (event: { dialogId: string; reason: string }) => void) => () => void;
  onBrowserOverlayDialogAction: (cb: (action: BrowserOverlayDialogAction) => void) => () => void;
}

type Translate = (key: string, params?: Record<string, string>) => string;
type DialogContent = Pick<BrowserOverlayDialogRequest, 'title' | 'message' | 'confirmLabel' | 'cancelLabel' | 'closeLabel' | 'variant' | 'dismissible' | 'agent' | 'singleAction' | 'files' | 'input'>;

function bridge(): PageDialogBridge | undefined {
  const value = (window as { kimiDesktop?: PageDialogBridge }).kimiDesktop;
  return typeof value?.browserGetPageDialogs === 'function' ? value : undefined;
}

export const browserPageDialogs = ref<BrowserPageDialog[]>([]);

export const browserApprovalBrowserIds = computed(() => [
  ...browserPermissionRequests.value.map(request => request.browserId),
  ...browserPageDialogs.value.filter(dialog => dialog.kind !== 'download' && (dialog.kind === 'upload' || (dialog.answerer === 'user' && dialog.agentChoice === undefined))).map(dialog => dialog.browserId),
]);

export function observeBrowserPageDialogs(): () => void {
  const native = bridge();
  if (!native) return () => {};
  let disposed = false;
  let revision = 0;
  const off = native.onBrowserPageDialogs(dialogs => { revision += 1; browserPageDialogs.value = dialogs; });
  void native.browserGetPageDialogs().then(dialogs => {
    if (!disposed && revision === 0) browserPageDialogs.value = dialogs;
  }).catch(error => console.error('Could not read browser page dialogs', error));
  return () => { disposed = true; off(); browserPageDialogs.value = []; };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function agentMark(dialog: BrowserPageDialog, t: Translate, choice: { confirm: string; cancel: string }): Pick<DialogContent, 'agent'> {
  if (dialog.agentChoice !== undefined) {
    return { agent: { label: t('browser.pageDialogs.agentChose', { choice: dialog.agentChoice === 'accepted' ? choice.confirm : choice.cancel }), hint: t('browser.pageDialogs.agentTabHint'), chosen: true } };
  }
  if (dialog.kind === 'upload') return { agent: { label: t('browser.pageDialogs.agentTab'), hint: t('browser.pageDialogs.agentRequestHint') } };
  return dialog.answerer === 'agent' ? { agent: { label: t('browser.pageDialogs.agentTab'), hint: t('browser.pageDialogs.agentTabHint') } } : {};
}

function withAgent(dialog: BrowserPageDialog, t: Translate, content: DialogContent): DialogContent {
  return { ...content, ...agentMark(dialog, t, { confirm: content.confirmLabel, cancel: content.cancelLabel }) };
}

export function browserPageDialogContent(dialog: BrowserPageDialog, t: Translate): DialogContent {
  const says = dialog.origin ? t('browser.pageDialogs.says', { origin: dialog.origin }) : t('browser.pageDialogs.pageSays');
  const cancel = t('browser.pageDialogs.cancel');
  switch (dialog.kind) {
    case 'alert': {
      const ok = t('browser.pageDialogs.ok');
      return withAgent(dialog, t, { title: says, message: dialog.message, confirmLabel: ok, cancelLabel: ok, closeLabel: ok, variant: 'primary', dismissible: false, singleAction: true });
    }
    case 'confirm':
      return withAgent(dialog, t, { title: says, message: dialog.message, confirmLabel: t('browser.pageDialogs.ok'), cancelLabel: cancel, closeLabel: cancel, variant: 'primary', dismissible: false });
    case 'prompt':
      return withAgent(dialog, t, { title: says, message: dialog.message, input: { label: t('browser.pageDialogs.promptLabel'), value: dialog.defaultValue ?? '', singleLine: true }, confirmLabel: t('browser.pageDialogs.ok'), cancelLabel: cancel, closeLabel: cancel, variant: 'primary', dismissible: false });
    case 'beforeunload': {
      const target = dialog.target ? `\n${t('browser.pageDialogs.leaveTarget', { target: dialog.target })}` : '';
      const repeat = dialog.repeat === 'form' ? `\n${t('browser.pageDialogs.leaveRepeatForm')}` : dialog.repeat === 'action' ? `\n${t('browser.pageDialogs.leaveRepeatAction')}` : '';
      return withAgent(dialog, t, { title: t('browser.beforeUnload.title'), message: `${dialog.origin}\n${t('browser.beforeUnload.message')}${target}${repeat}`, confirmLabel: t('browser.beforeUnload.leave'), cancelLabel: t('browser.beforeUnload.stay'), closeLabel: t('browser.beforeUnload.stay'), variant: 'danger', dismissible: false });
    }
    case 'file': {
      const types = dialog.accept?.length ? t('browser.pageDialogs.fileMessage', { types: dialog.accept.join(', ') }) : t('browser.pageDialogs.fileAny');
      return withAgent(dialog, t, { title: t('browser.pageDialogs.fileTitle', { origin: dialog.origin }), message: types, confirmLabel: t('browser.pageDialogs.chooseFiles'), cancelLabel: cancel, closeLabel: cancel, variant: 'primary', dismissible: false });
    }
    case 'upload': {
      const files = dialog.files ?? [];
      return withAgent(dialog, t, { title: t('browser.pageDialogs.uploadTitle'), message: t('browser.pageDialogs.uploadMessage', { count: String(files.length), origin: dialog.origin }), files: [...files], confirmLabel: t('browser.pageDialogs.allowOnce'), cancelLabel: t('browser.pageDialogs.deny'), closeLabel: t('browser.pageDialogs.deny'), variant: 'primary', dismissible: false });
    }
    case 'download': {
      const path = dialog.files?.[0] ?? '';
      return { title: t('browser.pageDialogs.downloadTitle'), message: t('browser.pageDialogs.downloadMessage', { file: dialog.message || fileName(path), path }), confirmLabel: t('browser.pageDialogs.move'), cancelLabel: t('browser.pageDialogs.keep'), closeLabel: t('browser.pageDialogs.keep'), variant: 'primary', dismissible: true };
    }
  }
}

export function activeBrowserPageDialog(dialogs: readonly BrowserPageDialog[], browserId: string): BrowserPageDialog | undefined {
  const own = dialogs.filter(item => item.browserId === browserId);
  return own.find(item => item.kind === 'alert' || item.kind === 'confirm' || item.kind === 'prompt')
    ?? own.find(item => item.kind === 'beforeunload')
    ?? own.find(item => item.kind === 'upload')
    ?? own.find(item => item.kind === 'file')
    ?? own[0];
}

export function browserPageDialogPreemptsPermission(dialogs: readonly BrowserPageDialog[], browserId: string): boolean {
  return dialogs.some(item => item.browserId === browserId && (item.kind === 'alert' || item.kind === 'confirm' || item.kind === 'prompt'));
}

export function useBrowserPageDialog(browserId: string, visible: () => boolean, viewport: Ref<HTMLElement | null>, t: Translate) {
  const native = bridge();
  let openId: string | undefined;
  let disposed = false;
  let offMenu: (() => void) | undefined;
  let offDialog: (() => void) | undefined;
  let off: (() => void) | undefined;
  function answer(dialogId: string, accept: boolean, text?: string): void {
    void native?.browserAnswerPageDialog({ dialogId, accept, ...(text === undefined ? {} : { text }) }).catch(error => console.error('Could not answer browser page dialog', error));
  }
  function sync(): void {
    if (disposed) return;
    const dialog = activeBrowserPageDialog(browserPageDialogs.value, browserId);
    const blocked = !browserPageDialogPreemptsPermission(browserPageDialogs.value, browserId) && browserPermissionRequests.value.some(item => item.browserId === browserId);
    const rect = viewport.value?.getBoundingClientRect();
    const show = native && dialog && !blocked && !browserOverlayAppDialogOpen.value && visible() && rect && rect.width > 0 && rect.height > 0;
    if (!show) { if (openId) native?.browserOverlayCloseDialog(openId); openId = undefined; return; }
    if (openId && openId !== dialog.dialogId) native.browserOverlayCloseDialog(openId);
    openId = dialog.dialogId;
    const content = browserPageDialogContent(dialog, t);
    native.browserOverlayOpenDialog({
      dialogId: dialog.dialogId, ...content, title: clip(content.title, 256), message: clip(content.message ?? '', 4096), preserveFocus: dialog.answerer === 'agent' || appUiHasFocus(),
      boundary: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  }
  watch([browserPageDialogs, browserPermissionRequests, browserOverlayAppDialogOpen, visible, viewport], sync, { flush: 'post' });
  onMounted(() => {
    offMenu = native?.onBrowserOverlayClosed(() => queueMicrotask(sync));
    offDialog = native?.onBrowserOverlayDialogClosed(event => {
      if (event.dialogId === openId) {
        openId = undefined;
        if (event.reason === 'replaced' || event.reason === 'window-blur') return;
        if (event.reason === 'dismiss' || event.reason === 'escape') {
          const dialog = browserPageDialogs.value.find(item => item.dialogId === event.dialogId);
          if (dialog?.kind === 'download') { answer(dialog.dialogId, false); return; }
        }
      }
      queueMicrotask(sync);
    });
    off = native?.onBrowserOverlayDialogAction(action => {
      if (action.dialogId !== openId) return;
      const accept = action.action === 'confirm';
      const prompt = browserPageDialogs.value.find(item => item.dialogId === action.dialogId)?.kind === 'prompt';
      answer(action.dialogId, accept, prompt && accept ? action.value ?? '' : undefined);
    });
    window.addEventListener('focus', sync);
    sync();
  });
  onUnmounted(() => { disposed = true; offMenu?.(); offDialog?.(); window.removeEventListener('focus', sync); if (openId) native?.browserOverlayCloseDialog(openId); off?.(); });
  return sync;
}
