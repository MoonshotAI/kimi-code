import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import type { BrowserPermissionDecision, BrowserPermissionRequest } from '../../shared/browser-sites';
import type { BrowserOverlayDialogAction, BrowserOverlayDialogRequest } from '../../shared/browser-overlay';
import { appUiHasFocus, browserOverlayAppDialogOpen } from './browserOverlayDialog';
import { openBrowserOverlayDialogCount } from './browserOverlayDialog';

interface PermissionBridge {
  browserGetPermissionRequests: () => Promise<BrowserPermissionRequest[]>;
  browserResolvePermissionRequest: (decision: BrowserPermissionDecision) => Promise<boolean>;
  onBrowserPermissionRequests: (cb: (requests: BrowserPermissionRequest[]) => void) => () => void;
  browserOverlayOpenDialog: (request: BrowserOverlayDialogRequest) => void;
  browserOverlayCloseDialog: (id: string) => void;
  onBrowserOverlayClosed: (cb: () => void) => () => void;
  onBrowserOverlayDialogClosed: (cb: (event: { dialogId: string; reason: string }) => void) => () => void;
  onBrowserOverlayDialogAction: (cb: (action: BrowserOverlayDialogAction) => void) => () => void;
}

function bridge(): PermissionBridge | undefined {
  const value = (window as { kimiDesktop?: PermissionBridge }).kimiDesktop;
  return typeof value?.browserGetPermissionRequests === 'function' ? value : undefined;
}

export const browserPermissionRequests = ref<BrowserPermissionRequest[]>([]);

export function observeBrowserPermissions(): () => void {
  const native = bridge();
  if (!native) return () => {};
  let disposed = false;
  let revision = 0;
  const off = native.onBrowserPermissionRequests(requests => { revision += 1; browserPermissionRequests.value = requests; });
  void native.browserGetPermissionRequests().then(requests => {
    if (!disposed && revision === 0) browserPermissionRequests.value = requests;
  }).catch(error => console.error('Could not read browser permission requests', error));
  return () => { disposed = true; off(); browserPermissionRequests.value = []; };
}

export function useBrowserPermissionDialog(browserId: string, visible: () => boolean, viewport: Ref<HTMLElement | null>, t: (key: string, params?: Record<string, string>) => string, locale: () => string = () => 'en', preempted: () => boolean = () => false) {
  const native = bridge();
  let openId: string | undefined;
  let disposed = false;
  let offMenu: (() => void) | undefined;
  let offDialog: (() => void) | undefined;
  let off: (() => void) | undefined;
  function setOpenId(next: string | undefined): void {
    if ((openId === undefined) !== (next === undefined)) openBrowserOverlayDialogCount.value += next === undefined ? -1 : 1;
    openId = next;
  }
  function sync(): void {
    if (disposed) return;
    const request = browserPermissionRequests.value.find(item => item.browserId === browserId);
    const rect = viewport.value?.getBoundingClientRect();
    const show = native && request && !preempted() && !browserOverlayAppDialogOpen.value && visible() && rect && rect.width > 0 && rect.height > 0;
    if (!show) { if (openId) native?.browserOverlayCloseDialog(openId); setOpenId(undefined); return; }
    if (openId && openId !== request.requestId) native.browserOverlayCloseDialog(openId);
    setOpenId(request.requestId);
    native.browserOverlayOpenDialog({
      dialogId: request.requestId, title: t('browser.sites.permissionTitle'),
      message: t('browser.sites.permissionRequest', { origin: request.origin, permissions: request.permissions.map(item => t(`browser.sites.permissions.${item}`)).join(locale().startsWith('zh') ? '、' : ', ') }),
      confirmLabel: t('browser.sites.allowOnce'), cancelLabel: t('browser.sites.block'), closeLabel: t('browser.sites.block'),
      auxiliary: { label: t('browser.sites.allowAlways') }, variant: 'primary', preserveFocus: appUiHasFocus(), dismissible: false,
      boundary: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  }
  watch([browserPermissionRequests, browserOverlayAppDialogOpen, visible, viewport, locale, preempted], sync, { flush: 'post' });
  onMounted(() => {
    offMenu = native?.onBrowserOverlayClosed(() => queueMicrotask(sync));
    offDialog = native?.onBrowserOverlayDialogClosed(event => {
      if (event.dialogId === openId) {
        setOpenId(undefined);
        if (event.reason === 'replaced' || event.reason === 'window-blur') return;
      }
      queueMicrotask(sync);
    });
    off = native?.onBrowserOverlayDialogAction(action => {
      if (action.dialogId !== openId) return;
      void native.browserResolvePermissionRequest({ requestId: action.dialogId, decision: action.action === 'confirm' ? 'allow-once' : action.action === 'auxiliary' ? 'allow-always' : 'block' }).catch(error => console.error('Could not resolve browser permission', error));
    });
    window.addEventListener('focus', sync);
    sync();
  });
  onUnmounted(() => { disposed = true; offMenu?.(); offDialog?.(); window.removeEventListener('focus', sync); if (openId) native?.browserOverlayCloseDialog(openId); setOpenId(undefined); off?.(); });
  return sync;
}
