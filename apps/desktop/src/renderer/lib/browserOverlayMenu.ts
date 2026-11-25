import { v4 as randomUUID } from 'uuid';
import { createBrowserFocusRequest } from './browserFocusRequest';
import { onScopeDispose, readonly, ref, watch, type Ref } from 'vue';
import { openDialogCount, registerExternalMenuSurface } from '@moonshot-ai/app-ui';
import type { QuickModelMenuAction, QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import type {
  BrowserOverlayAction,
  BrowserOverlayAnchor,
  BrowserOverlayClosed,
  BrowserOverlayInitialFocus,
  BrowserOverlayMenuItem,
  BrowserOverlayMenuRequest,
  BrowserOverlayPlacement,
} from '../../shared/browser-overlay';

interface BrowserOverlayHostBridge {
  browserOverlaySupported: boolean;
  browserOverlayOpenMenu: (request: BrowserOverlayMenuRequest) => void;
  browserOverlayCloseMenu: (menuId: string) => void;
  onBrowserOverlayAction: (cb: (payload: BrowserOverlayAction) => void) => () => void;
  onBrowserOverlayClosed: (cb: (payload: BrowserOverlayClosed) => void) => () => void;
}

export interface BrowserOverlayMenuRegistration {
  id: string;
  items: () => BrowserOverlayMenuItem[];
  modelMenu?: () => QuickModelMenuPayload;
  footerStart?: () => number;
  highlightQuery?: () => string;
  onSelect: (itemId: string) => void;
  onModelAction?: (action: QuickModelMenuAction) => void;
  onClose?: (payload: BrowserOverlayClosed) => void;
  onDismiss?: () => void;
  width?: number;
  maxHeight?: number;
  autoWidth?: boolean;
  preserveFocus?: boolean;
  submitOnCtrlEnter?: boolean;
  placement?: BrowserOverlayPlacement;
  offset?: number;
}

interface BrowserOverlayShowOptions {
  placement?: BrowserOverlayPlacement;
  offset?: number;
  initialFocus?: BrowserOverlayInitialFocus;
  preserveFocus?: boolean;
}

interface BrowserOverlayAnchorOptions extends BrowserOverlayShowOptions {
  focusReturn?: HTMLElement;
}

export interface BrowserOverlayMenuHandle {
  available: boolean;
  request: <T>(load: () => Promise<T>) => Promise<T | undefined>;
  open: Readonly<Ref<boolean>>;
  closing: Readonly<Ref<boolean>>;
  show: (trigger: HTMLElement, options?: BrowserOverlayShowOptions) => void;
  showAt: (anchor: BrowserOverlayAnchor, options?: BrowserOverlayAnchorOptions) => void;
  toggle: (trigger: HTMLElement, options?: BrowserOverlayShowOptions) => void;
  refresh: () => void;
  close: (options?: { refocus?: boolean }) => void;
  dispose: () => void;
}

function bridgeCandidate(): Partial<BrowserOverlayHostBridge> | undefined {
  return (window as { kimiDesktop?: Partial<BrowserOverlayHostBridge> }).kimiDesktop;
}

function browserOverlayBridge(): BrowserOverlayHostBridge | null {
  const bridge = bridgeCandidate();
  if (
    bridge?.browserOverlaySupported !== true ||
    typeof bridge.browserOverlayOpenMenu !== 'function' ||
    typeof bridge.browserOverlayCloseMenu !== 'function' ||
    typeof bridge.onBrowserOverlayAction !== 'function' ||
    typeof bridge.onBrowserOverlayClosed !== 'function'
  ) {
    return null;
  }
  return bridge as BrowserOverlayHostBridge;
}

const registeredIds = new Set<string>();




export function registerBrowserOverlayMenu(
  registration: BrowserOverlayMenuRegistration,
): BrowserOverlayMenuHandle {
  if (registeredIds.has(registration.id)) {
    throw new Error(`browser-overlay: duplicate menu id ${registration.id}`);
  }
  registeredIds.add(registration.id);
  const bridge = browserOverlayBridge();
  const open = ref(false);
  const closePending = ref(false);
  let nativeMenuId: string = randomUUID();
  let actionConsumed = false;
  const focusReturn = createBrowserFocusRequest({ allowInactiveDocument: true });
  let triggerEl: HTMLElement | null = null;
  let toggleTriggerEl: HTMLElement | null = null;
  let releaseSurface: (() => void) | null = null;
  let pendingRefocus = false;
  let cancelRequest: (() => void) | null = null;
  let disposed = false;
  let currentAnchor: BrowserOverlayAnchor | null = null;
  let currentOptions:
    | {
        placement?: BrowserOverlayPlacement;
        offset?: number;
        initialFocus?: BrowserOverlayInitialFocus;
        preserveFocus?: boolean;
        focusReturn?: HTMLElement;
      }
    | undefined;

  async function request<T>(load: () => Promise<T>): Promise<T | undefined> {
    cancelRequest?.();
    if (disposed) return undefined;
    const focusedElement = document.activeElement;
    let cancelled = false;
    const cancel = (): void => { cancelled = true; cleanup(); };
    const onFocus = (): void => { if (document.activeElement !== focusedElement) cancel(); };
    const onKeydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel(); };
    const cleanup = (): void => {
      document.removeEventListener('mousedown', cancel, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('blur', cancel);
      if (cancelRequest === cancel) cancelRequest = null;
    };
    cancelRequest = cancel;
    document.addEventListener('mousedown', cancel, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('blur', cancel);
    try {
      const result = await load();
      return cancelled || disposed || !document.hasFocus() ? undefined : result;
    } finally {
      cleanup();
    }
  }

  function finish(options?: { refocus?: boolean }): void {
    if (!open.value && releaseSurface === null) return;
    open.value = false;
    closePending.value = false;
    releaseSurface?.();
    releaseSurface = null;
    document.removeEventListener('mousedown', onDocumentMousedown, true);
    toggleTriggerEl = null;
    currentAnchor = null;
    currentOptions = undefined;
    if (options?.refocus) {
      const target = triggerEl;
      const previousFocus = document.activeElement;
      void focusReturn.run(
        () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())),
        () => target?.focus(),
        () => !disposed && !open.value && target?.isConnected === true && document.activeElement === previousFocus,
      );
    }
  }

  function onDocumentMousedown(event: MouseEvent): void {
    if (toggleTriggerEl?.contains(event.target as Node)) return;
    close();
  }

  const offAction = bridge?.onBrowserOverlayAction((payload) => {
    if (payload.menuId !== nativeMenuId || disposed || actionConsumed) return;
    if (payload.keepOpen !== true) { actionConsumed = true; finish(); }
    if (payload.modelAction !== undefined) registration.onModelAction?.(payload.modelAction);
    else registration.onSelect(payload.itemId);
  });
  const offClosed = bridge?.onBrowserOverlayClosed((payload) => {
    if (payload.menuId !== nativeMenuId || disposed) return;
    if (payload.reason !== 'action') actionConsumed = true;
    const refocus = pendingRefocus || payload.reason === 'escape';
    pendingRefocus = false;
    finish({ refocus });
    registration.onClose?.(payload);
    if (payload.reason === 'dismiss') registration.onDismiss?.();
  });

  function show(
    trigger: HTMLElement,
    options?: BrowserOverlayShowOptions,
  ): void {
    const rect = trigger.getBoundingClientRect();
    showAt(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { ...options, focusReturn: trigger },
    );
    toggleTriggerEl = trigger;
  }

  function showAt(
    anchor: BrowserOverlayAnchor,
    options?: BrowserOverlayAnchorOptions,
    refreshOpening = false,
  ): void {
    if (bridge === null || disposed) return;
    const refreshing = refreshOpening && open.value && !closePending.value;
    if (!refreshing) { nativeMenuId = randomUUID(); actionConsumed = false; }
    closePending.value = false;
    focusReturn.cancel();
    currentAnchor = { ...anchor };
    currentOptions = options;
    triggerEl = options?.focusReturn ?? null;
    toggleTriggerEl = null;
    pendingRefocus = false;
    if (!open.value) {
      open.value = true;
      releaseSurface = registerExternalMenuSurface();
      document.addEventListener('mousedown', onDocumentMousedown, true);
    }
    bridge.browserOverlayOpenMenu({
      menuId: nativeMenuId,
      ...(refreshing ? { refresh: true } : {}),
      anchor,
      placement: options?.placement ?? registration.placement ?? 'bottom-end',
      offset: options?.offset ?? registration.offset ?? 4,
      width: registration.width ?? 220,
      ...(registration.maxHeight === undefined ? {} : { maxHeight: registration.maxHeight }),
      ...(registration.autoWidth === true ? { autoWidth: true } : {}),
      initialFocus: options?.initialFocus ?? 'none',
      preserveFocus: options?.preserveFocus ?? registration.preserveFocus,
      submitOnCtrlEnter: registration.submitOnCtrlEnter === true ? true : undefined,
      items: registration.items(),
      ...(registration.modelMenu === undefined ? {} : { modelMenu: registration.modelMenu() }),
      ...(registration.footerStart === undefined ? {} : { footerStart: registration.footerStart() }),
      ...(registration.highlightQuery === undefined ? {} : { query: registration.highlightQuery().slice(0, 1024) }),
    });
  }

  function close(options?: { refocus?: boolean }): void {
    cancelRequest?.();
    if (!open.value) return;
    pendingRefocus ||= options?.refocus === true;
    if (bridge === null) {
      finish({ refocus: pendingRefocus });
      pendingRefocus = false;
      return;
    }
    closePending.value = true;
    bridge.browserOverlayCloseMenu(nativeMenuId);
  }

  const stopDialogWatch = watch(
    openDialogCount,
    (count, previous) => { if (count > previous) close(); },
    { flush: 'sync' },
  );

  function refresh(): void {
    if (!open.value || closePending.value || currentAnchor === null) return;
    const trigger = toggleTriggerEl;
    showAt(currentAnchor, currentOptions, true);
    toggleTriggerEl = trigger;
  }

  function toggle(
    trigger: HTMLElement,
    options?: BrowserOverlayShowOptions,
  ): void {
    if (open.value) close({ refocus: true });
    else show(trigger, options);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopDialogWatch();
    focusReturn.cancel();
    cancelRequest?.();
    if (open.value) bridge?.browserOverlayCloseMenu(nativeMenuId);
    finish();
    offAction?.();
    offClosed?.();
    registeredIds.delete(registration.id);
  }

  onScopeDispose(dispose);
  return {
    available: bridge !== null,
    request,
    open: readonly(open),
    closing: readonly(closePending),
    show,
    showAt,
    toggle,
    refresh,
    close,
    dispose,
  };
}
