import { ref } from 'vue';
import type {
  BrowserOverlayDialogAction,
  BrowserOverlayDialogClosed,
  BrowserOverlayDialogRequest,
} from '../../shared/browser-overlay';

interface BrowserOverlayDialogBridge {
  browserOverlayOpenDialog: (request: BrowserOverlayDialogRequest) => void;
  browserOverlayCloseDialog: (dialogId: string) => void;
  onBrowserOverlayDialogAction: (cb: (payload: BrowserOverlayDialogAction) => void) => () => void;
  onBrowserOverlayDialogClosed: (cb: (payload: BrowserOverlayDialogClosed) => void) => () => void;
}

function bridgeCandidate(): Partial<BrowserOverlayDialogBridge> | undefined {
  return (window as { kimiDesktop?: Partial<BrowserOverlayDialogBridge> }).kimiDesktop;
}

function bridge(): BrowserOverlayDialogBridge | null {
  const candidate = bridgeCandidate();
  if (
    typeof candidate?.browserOverlayOpenDialog !== 'function' ||
    typeof candidate.browserOverlayCloseDialog !== 'function' ||
    typeof candidate.onBrowserOverlayDialogAction !== 'function' ||
    typeof candidate.onBrowserOverlayDialogClosed !== 'function'
  ) {
    return null;
  }
  return candidate as BrowserOverlayDialogBridge;
}

const openAppDialogs = new Set<symbol>();
export const browserOverlayAppDialogOpen = ref(false);

function markAppDialog(token: symbol, isOpen: boolean): void {
  if (isOpen) openAppDialogs.add(token);
  else openAppDialogs.delete(token);
  browserOverlayAppDialogOpen.value = openAppDialogs.size > 0;
}

export const openBrowserOverlayDialogCount = ref(0);

export function appUiHasFocus(): boolean {
  return typeof document !== 'undefined' && document.hasFocus();
}

export function canUseBrowserOverlayDialog(): boolean {
  return bridge() !== null;
}

export interface BrowserOverlayDialogHandle {
  available: boolean;
  show: (request: Omit<BrowserOverlayDialogRequest, 'dialogId' | 'viewport'>, generation?: string) => void;
  close: () => void;
  dispose: () => void;
}

export function registerBrowserOverlayDialog(options: {
  id: string;
  onConfirm: (value?: string, checked?: boolean) => void;
  onAuxiliary?: (value?: string, checked?: boolean) => void;
  onCancel: () => void;
}): BrowserOverlayDialogHandle {
  const nativeBridge = bridge();
  let open = false;
  let disposed = false;
  const token = Symbol(options.id);
  function setOpen(next: boolean): void {
    if (open !== next) openBrowserOverlayDialogCount.value += next ? 1 : -1;
    open = next;
  }
  let activeId = options.id;
  let currentRequest: Omit<BrowserOverlayDialogRequest, 'dialogId' | 'viewport'> | null = null;

  function sendCurrent(): void {
    if (disposed || !open || nativeBridge === null || currentRequest === null) return;
    nativeBridge.browserOverlayOpenDialog({
      ...currentRequest,
      dialogId: activeId,
      viewport: {
        width: Math.max(1, Math.round(window.innerWidth)),
        height: Math.max(1, Math.round(window.innerHeight)),
      },
    });
  }

  const offAction = nativeBridge?.onBrowserOverlayDialogAction((payload) => {
    if (disposed || payload.dialogId !== activeId) return;
    if (payload.action === 'confirm') options.onConfirm(payload.value, payload.checked);
    else if (payload.action === 'auxiliary') options.onAuxiliary?.(payload.value, payload.checked);
    else options.onCancel();
  });
  const offClosed = nativeBridge?.onBrowserOverlayDialogClosed((payload) => {
    if (disposed || payload.dialogId !== activeId) return;
    setOpen(false);
    currentRequest = null;
    markAppDialog(token, false);
    options.onCancel();
  });

  function show(request: Omit<BrowserOverlayDialogRequest, 'dialogId' | 'viewport'>, generation?: string): void {
    if (disposed || nativeBridge === null) return;
    activeId = generation === undefined ? options.id : `${options.id}:${generation}`;
    setOpen(true);
    currentRequest = request;
    markAppDialog(token, true);
    sendCurrent();
  }

  function close(): void {
    if (!open) return;
    setOpen(false);
    currentRequest = null;
    markAppDialog(token, false);
    nativeBridge?.browserOverlayCloseDialog(activeId);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (open) nativeBridge?.browserOverlayCloseDialog(activeId);
    setOpen(false);
    currentRequest = null;
    markAppDialog(token, false);
    window.removeEventListener('resize', sendCurrent);
    document.removeEventListener('mousedown', onOutsidePointer, true);
    offAction?.();
    offClosed?.();
  }

  function onOutsidePointer(): void {
    if (open && currentRequest?.anchor !== undefined) options.onCancel();
  }

  document.addEventListener('mousedown', onOutsidePointer, true);
  window.addEventListener('resize', sendCurrent);

  return { available: nativeBridge !== null, show, close, dispose };
}
