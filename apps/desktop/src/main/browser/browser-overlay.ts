import { browserAnnotationViewBounds } from './browser-annotations';
import { browserCaptureBindingId } from '@moonshot-ai/app-core/browser-reference';
import { app, WebContentsView } from 'electron';
import type { MouseInputEvent, Rectangle, View, WebContents } from 'electron';
import type { MainWindow } from '../window/main-window';
import { join } from 'node:path';

import {
  BROWSER_OVERLAY_GUTTER,
  type BrowserOverlayAction,
  type BrowserOverlayActivateRequest,
  type BrowserOverlayDismissRequest,
  type BrowserOverlayCloseReason,
  type BrowserOverlayClosed,
  type BrowserOverlayConfig,
  type BrowserOverlayDialogAction,
  type BrowserOverlayFormAction,
  type BrowserOverlayDialogClosed,
  type BrowserOverlayDialogRequest,
  type BrowserOverlayMenuConfig,
  type BrowserOverlayMenuRequest,
  type BrowserOverlayRendered,
  type BrowserOverlayShown,
  type BrowserOverlayVisibilityRequest,
  type BrowserOverlayViewport,
} from '../../shared/browser-overlay';
import { IPC } from '../ipc/ipc-channels';
import { log } from '../diagnostics/log';
import { rendererDevBase } from '../app/protocol';

const PROVISIONAL_HEIGHT = 720;
const VIEWPORT_MARGIN = 8;
export const MODEL_OVERLAY_MENU_WIDTH = 240;
export const MODEL_OVERLAY_MAX_HEIGHT = 480;
export const MODEL_OVERLAY_ANCHOR_OFFSET = 8;
export const MODEL_OVERLAY_FLYOUT_RESERVE_X = 244;
export const MODEL_OVERLAY_FLYOUT_RESERVE_Y = 72;

interface BrowserOverlayEntry {
  host: MainWindow;
  view: WebContentsView;
  ready: boolean;
  zoom: number;
  disposed: boolean;
  visible: boolean;
  nextRequestId: number;
  current: BrowserOverlayConfig | null;
  closingRequestId: number | null;
  restoreFocusOnHide: boolean;
  initialUrl: string;
}

let hostWindow: MainWindow | null = null;
let overlayEntry: BrowserOverlayEntry | null = null;
const outsidePointerContents = new WeakSet<WebContents>();

export function observeBrowserOverlayOutsidePointer(contents: WebContents, isUserSurface: () => boolean = () => true): void {
  if (outsidePointerContents.has(contents)) return;
  outsidePointerContents.add(contents);
  contents.on('before-mouse-event', (_event, mouse: MouseInputEvent) => {
    if (mouse.type !== 'mouseDown' || !isUserSurface()) return;
    closeBrowserOverlayMenu(undefined, 'dismiss');
    const current = liveEntry()?.current;
    if (current?.kind === 'dialog' && current.anchor !== undefined) closeBrowserOverlayDialog(undefined, 'dismiss');
  });
}

export function isBrowserOverlayView(view: View): boolean {
  return overlayEntry !== null && overlayEntry.view === view;
}

function liveHost(): MainWindow | null {
  return hostWindow !== null && !hostWindow.isDestroyed() ? hostWindow : null;
}

function liveEntry(): BrowserOverlayEntry | null {
  const entry = overlayEntry;
  if (entry === null || entry.host.isDestroyed() || entry.view.webContents.isDestroyed()) {
    if (entry !== null) destroyEntry(entry);
    return null;
  }
  return entry;
}

function overlayUrl(): string {
  const devBase = app.isPackaged ? undefined : rendererDevBase(process.env['KIMI_RENDERER_DEV_URL']);
  return devBase === undefined
    ? 'app://renderer/browser-overlay.html'
    : new URL('browser-overlay.html', devBase).toString();
}

function sendClosed(config: BrowserOverlayConfig, reason: BrowserOverlayCloseReason): void {
  if (config.kind === 'dialog') {
    const payload: BrowserOverlayDialogClosed = { dialogId: config.dialogId, reason };
    liveHost()?.webContents.send(IPC.browserOverlayDialogClosed, payload);
    return;
  }
  const payload: BrowserOverlayClosed = { menuId: config.menuId, reason };
  liveHost()?.webContents.send(IPC.browserOverlayClosed, payload);
}

function hostContentSize(host: MainWindow, preferred?: BrowserOverlayViewport): [number, number] {
  if (preferred !== undefined) return [preferred.width, preferred.height];
  const size = host.getContentSize();
  if ((size[0] ?? 0) > 0 && (size[1] ?? 0) > 0) return [size[0]!, size[1]!];
  const rootBounds = host.contentView.getBounds();
  if (rootBounds.width > 0 && rootBounds.height > 0) {
    return [rootBounds.width, rootBounds.height];
  }
  const contentBounds = host.getContentBounds();
  if (contentBounds.width > 0 && contentBounds.height > 0) {
    return [contentBounds.width, contentBounds.height];
  }
  const windowBounds = host.getBounds();
  return [Math.max(1, windowBounds.width), Math.max(1, windowBounds.height)];
}

function finishHideEntry(entry: BrowserOverlayEntry, requestId: number): void {
  if (entry.closingRequestId !== requestId || entry.current !== null) return;
  const restoreFocus = entry.restoreFocusOnHide
    && !entry.host.isDestroyed()
    && !entry.host.webContents.isDestroyed()
    && entry.host.isFocused()
    && entry.view.webContents.isFocused();
  entry.closingRequestId = null;
  entry.restoreFocusOnHide = false;
  entry.visible = false;
  entry.view.setVisible(false);
  if (restoreFocus && !entry.host.isDestroyed() && !entry.host.webContents.isDestroyed()) entry.host.webContents.focus();
}

function hideEntry(
  entry: BrowserOverlayEntry,
  reason: BrowserOverlayCloseReason,
  animate = true,
): void {
  const current = entry.current;
  if (current === null) return;
  const { requestId } = current;
  entry.current = null;
  entry.closingRequestId = requestId;
  entry.restoreFocusOnHide = !(current.kind === 'dialog' && current.preserveFocus && current.anchor !== undefined) && (reason === 'action' || reason === 'escape' || reason === 'dismiss' || reason === 'programmatic');
  sendClosed(current, reason);
  if (animate && entry.ready && entry.visible && !entry.view.webContents.isDestroyed()) {
    entry.view.webContents.send(IPC.browserOverlayHide, {
      requestId,
    } satisfies BrowserOverlayVisibilityRequest);
    return;
  }
  finishHideEntry(entry, requestId);
}

function destroyEntry(entry: BrowserOverlayEntry | null = overlayEntry, reason: 'host-closed' | 'replaced' = 'host-closed'): void {
  if (entry === null || entry.disposed) return;
  entry.disposed = true;
  if (overlayEntry === entry) overlayEntry = null;
  if (
    entry.current !== null &&
    !entry.host.isDestroyed() &&
    !entry.host.webContents.isDestroyed()
  ) {
    sendClosed(entry.current, reason);
  }
  entry.current = null;
  entry.closingRequestId = null;
  entry.visible = false;
  entry.view.setVisible(false);
  if (!entry.host.isDestroyed()) entry.host.contentView.removeChildView(entry.view);
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}

function flushConfig(entry: BrowserOverlayEntry): void {
  const current = entry.current;
  if (!entry.ready || current === null || entry.view.webContents.isDestroyed()) return;
  entry.zoom = current.kind === 'menu' ? entry.host.webContents.getZoomFactor() : 1;
  entry.view.webContents.setZoomFactor(entry.zoom);
  if (current.kind === 'dialog') {
    if (current.annotation) current.boundary = browserAnnotationViewBounds(browserCaptureBindingId(current.annotation.capture));
    const size = hostContentSize(entry.host, current.viewport);
    if (current.annotation && current.anchor !== undefined) entry.view.setBounds(current.boundary ?? { x: 0, y: 0, width: size[0], height: size[1] });
    else if (!entry.visible || !current.annotation) entry.view.setBounds(current.anchor === undefined && current.boundary ? current.boundary : { x: 0, y: 0, width: current.anchor === undefined ? size[0] : Math.min(PROVISIONAL_HEIGHT, size[0]), height: current.anchor === undefined ? size[1] : Math.min(PROVISIONAL_HEIGHT, size[1]) });




    entry.view.setVisible(true);
  } else {
    const [contentWidth, contentHeight] = hostContentSize(entry.host).map(size => size / entry.zoom) as [number, number];
    if (current.modelMenu !== undefined) {
      current.minWidth = MODEL_OVERLAY_MENU_WIDTH;
      current.width = MODEL_OVERLAY_MENU_WIDTH;
      current.autoWidth = false;
      current.offset = MODEL_OVERLAY_ANCHOR_OFFSET;
      current.maxHeight = modelOverlayMaxHeight(current.anchor.y, contentHeight);
      if (!entry.visible) {
        const provisionalWidth = Math.min(contentWidth, MODEL_OVERLAY_MENU_WIDTH + (MODEL_OVERLAY_FLYOUT_RESERVE_X + BROWSER_OVERLAY_GUTTER) * 2);
        const provisionalHeight = Math.min(contentHeight, current.maxHeight + (MODEL_OVERLAY_FLYOUT_RESERVE_Y + BROWSER_OVERLAY_GUTTER) * 2);
        entry.view.setBounds({ x: 0, y: 0, width: Math.ceil(provisionalWidth * entry.zoom), height: Math.ceil(provisionalHeight * entry.zoom) });
      }
    } else {
      const maxWidth = Math.max(1, contentWidth - BROWSER_OVERLAY_GUTTER * 2);
      current.minWidth = Math.min(current.minWidth ?? current.width ?? 220, maxWidth);
      current.width = current.autoWidth === true ? maxWidth : current.minWidth;
      current.maxHeight = Math.max(
        1,
        Math.min(current.maxHeight ?? PROVISIONAL_HEIGHT, PROVISIONAL_HEIGHT, contentHeight - BROWSER_OVERLAY_GUTTER * 2),
      );
      const width = current.width + BROWSER_OVERLAY_GUTTER * 2;
      if (!entry.visible) entry.view.setBounds({ x: 0, y: 0, width: Math.ceil(width * entry.zoom), height: Math.ceil((current.maxHeight + BROWSER_OVERLAY_GUTTER * 2) * entry.zoom) });
    }
  }
  entry.view.webContents.send(IPC.browserOverlayConfig, current);
}

function ensureEntry(): BrowserOverlayEntry {
  const existing = liveEntry();
  if (existing !== null) return existing;
  const host = liveHost();
  if (host === null) throw new Error('browser-overlay: main window is unavailable');

  const initialUrl = overlayUrl();
  const browserOverlayView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'browser-overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browserOverlayView.setBackgroundColor('#00000000');
  browserOverlayView.setVisible(false);
  browserOverlayView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  host.contentView.addChildView(browserOverlayView);

  const entry: BrowserOverlayEntry = {
    host,
    view: browserOverlayView,
    ready: false,
    zoom: 1,
    disposed: false,
    visible: false,
    nextRequestId: 0,
    current: null,
    closingRequestId: null,
    restoreFocusOnHide: false,
    initialUrl,
  };
  overlayEntry = entry;

  browserOverlayView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserOverlayView.webContents.on('will-navigate', (event, url) => {
    if (url === initialUrl) return;
    event.preventDefault();
  });
  browserOverlayView.webContents.once('destroyed', () => destroyEntry(entry, 'replaced'));
  browserOverlayView.webContents.on('render-process-gone', () => destroyEntry(entry, 'replaced'));
  void browserOverlayView.webContents.loadURL(initialUrl).catch((error) => {
    log.error(`[kimi-desktop] browser overlay failed to load: ${String(error)}`);
    destroyEntry(entry, 'replaced');
  });
  return entry;
}



export function attachBrowserOverlayWindow(win: MainWindow): void {
  if (hostWindow !== null && hostWindow !== win) destroyEntry();
  hostWindow = win;
  ensureEntry();
  win.webContents.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const entry = liveEntry();
    if (entry !== null) hideEntry(entry, 'host-closed', false);
  });
  win.on('blur', () => {
    if (liveEntry()?.current?.kind === 'menu') closeBrowserOverlayMenu(undefined, 'window-blur');
    const current = liveEntry()?.current;
    if (current?.kind === 'dialog' && current.anchor !== undefined) closeBrowserOverlayDialog(undefined, 'window-blur');
  });
  win.on('move', () => {
    if (liveEntry()?.current?.kind === 'menu') closeBrowserOverlayMenu(undefined, 'window-move');
  });
  win.on('resize', () => {
    const entry = liveEntry();
    if (entry?.current?.kind === 'dialog' && entry.current.anchor !== undefined && !entry.current.annotation) closeBrowserOverlayDialog(undefined, 'window-resize');
    else if (entry?.current?.kind === 'dialog') flushConfig(entry);
    else closeBrowserOverlayMenu(undefined, 'window-resize');
  });
  win.once('closed', () => {
    if (hostWindow !== win) return;
    destroyEntry();
    hostWindow = null;
  });
}

export function openBrowserOverlayMenu({ refresh, ...request }: BrowserOverlayMenuRequest): void {
  const entry = ensureEntry();
  const current = entry.current;
  if (current?.kind === 'menu' && current.menuId === request.menuId) {
    entry.current = { ...request, kind: 'menu', requestId: current.requestId };
    flushConfig(entry);
    return;
  }
  if (refresh === true) return;
  if (entry.current !== null) hideEntry(entry, 'replaced', false);
  if (entry.closingRequestId !== null) {
    entry.closingRequestId = null;
    entry.visible = false;
    entry.view.setVisible(false);
  }
  entry.nextRequestId += 1;
  entry.current = { ...request, kind: 'menu', requestId: entry.nextRequestId };
  flushConfig(entry);
}

export function openBrowserOverlayDialog(request: BrowserOverlayDialogRequest): void {
  const entry = ensureEntry();
  const current = entry.current;
  if (current?.kind === 'dialog' && current.dialogId === request.dialogId) {
    entry.current = { ...request, kind: 'dialog', requestId: current.requestId };
    flushConfig(entry);
    return;
  }
  if (current !== null) hideEntry(entry, 'replaced', false);
  if (entry.closingRequestId !== null) {
    entry.closingRequestId = null;
    entry.visible = false;
    entry.view.setVisible(false);
  }
  entry.nextRequestId += 1;
  entry.current = { ...request, kind: 'dialog', requestId: entry.nextRequestId };
  flushConfig(entry);
}

export function closeBrowserOverlayMenu(
  menuId?: string,
  reason: BrowserOverlayCloseReason = 'dismiss',
): void {
  const entry = liveEntry();
  if (entry === null || entry.current?.kind !== 'menu') return;
  if (menuId !== undefined && entry.current.menuId !== menuId) return;
  hideEntry(entry, reason);
}

export function closeBrowserOverlayDialog(
  dialogId?: string,
  reason: BrowserOverlayCloseReason = 'dismiss',
): void {
  const entry = liveEntry();
  if (entry === null || entry.current?.kind !== 'dialog') return;
  if (dialogId !== undefined && entry.current.dialogId !== dialogId) return;
  if ((reason === 'dismiss' || reason === 'escape') && entry.current.loading === true) return;
  hideEntry(entry, reason);
}

export function isBrowserOverlaySender(contents: WebContents): boolean {
  const entry = liveEntry();
  return entry !== null && entry.view.webContents === contents;
}

export function markBrowserOverlayReady(contents: WebContents): void {
  const entry = liveEntry();
  if (entry === null || entry.view.webContents !== contents) return;
  entry.ready = true;
  flushConfig(entry);
}

export interface BrowserOverlayPositionInput {
  contentWidth: number;
  contentHeight: number;
  config: BrowserOverlayMenuConfig | Pick<BrowserOverlayMenuConfig, 'anchor' | 'placement' | 'offset'>;
  cardWidth: number;
  cardHeight: number;
  allowFlip?: boolean;
}

interface BrowserOverlayLayout {
  bounds: Rectangle;
  placement: BrowserOverlayMenuConfig['placement'];
}




function browserOverlayLayout({
  contentWidth,
  contentHeight,
  config,
  cardWidth,
  cardHeight,
  allowFlip = true,
}: BrowserOverlayPositionInput): BrowserOverlayLayout {
  const margin = Math.max(VIEWPORT_MARGIN, BROWSER_OVERLAY_GUTTER);
  const placement = config.placement ?? 'bottom-end';
  const offset = config.offset ?? 4;
  const endAligned = placement.endsWith('-end');
  const prefersBottom = placement.startsWith('bottom-');
  let resolvedPlacement = placement;
  let cardX = endAligned
    ? config.anchor.x + config.anchor.width - cardWidth
    : config.anchor.x;
  const belowY = config.anchor.y + config.anchor.height + offset;
  const aboveY = config.anchor.y - cardHeight - offset;
  let cardY = prefersBottom ? belowY : aboveY;
  const preferredFits =
    cardY >= margin && cardY + cardHeight <= contentHeight - margin;
  if (allowFlip && !preferredFits) {
    const alternateY = prefersBottom ? aboveY : belowY;
    const alternateFits =
      alternateY >= margin &&
      alternateY + cardHeight <= contentHeight - margin;
    if (alternateFits) {
      cardY = alternateY;
      resolvedPlacement = `${prefersBottom ? 'top' : 'bottom'}-${endAligned ? 'end' : 'start'}`;
    }
  }
  cardX = Math.min(
    Math.max(margin, cardX),
    Math.max(margin, contentWidth - margin - cardWidth),
  );
  cardY = Math.min(
    Math.max(margin, cardY),
    Math.max(margin, contentHeight - margin - cardHeight),
  );
  const x = Math.max(0, cardX - BROWSER_OVERLAY_GUTTER);
  const y = Math.max(0, cardY - BROWSER_OVERLAY_GUTTER);
  return {
    placement: resolvedPlacement,
    bounds: {
      x,
      y,
      width: Math.min(contentWidth - x, cardWidth + BROWSER_OVERLAY_GUTTER * 2),
      height: Math.min(contentHeight - y, cardHeight + BROWSER_OVERLAY_GUTTER * 2),
    },
  };
}

export function browserOverlayBounds(input: BrowserOverlayPositionInput): Rectangle {
  return browserOverlayLayout(input).bounds;
}

export function modelOverlayMaxHeight(anchorY: number, contentHeight: number): number {
  const availableAbove = Math.floor(anchorY - VIEWPORT_MARGIN * 2);
  return Math.max(
    96,
    Math.min(MODEL_OVERLAY_MAX_HEIGHT, availableAbove, Math.floor(contentHeight - VIEWPORT_MARGIN * 2)),
  );
}

export interface BrowserModelOverlayLayoutInput {
  contentWidth: number;
  contentHeight: number;
  anchor: Rectangle;
  menuHeight: number;
}

export interface BrowserModelOverlayLayout {
  bounds: Rectangle;
  menuOffset: { x: number; y: number };
}

export function browserModelOverlayLayout(input: BrowserModelOverlayLayoutInput): BrowserModelOverlayLayout {
  const { contentWidth, contentHeight, anchor } = input;
  const menuWidth = MODEL_OVERLAY_MENU_WIDTH;
  const menuHeight = Math.max(1, Math.min(input.menuHeight, modelOverlayMaxHeight(anchor.y, contentHeight)));
  const maxMenuX = Math.max(VIEWPORT_MARGIN, contentWidth - VIEWPORT_MARGIN - menuWidth);
  const menuX = Math.min(Math.max(VIEWPORT_MARGIN, anchor.x + anchor.width - menuWidth), maxMenuX);
  const maxMenuY = Math.max(VIEWPORT_MARGIN, contentHeight - VIEWPORT_MARGIN - menuHeight);
  const menuY = Math.min(Math.max(VIEWPORT_MARGIN, anchor.y - MODEL_OVERLAY_ANCHOR_OFFSET - menuHeight), maxMenuY);
  const x = Math.max(0, Math.floor(menuX - MODEL_OVERLAY_FLYOUT_RESERVE_X - BROWSER_OVERLAY_GUTTER));
  const y = Math.max(0, Math.floor(menuY - MODEL_OVERLAY_FLYOUT_RESERVE_Y - BROWSER_OVERLAY_GUTTER));
  const right = Math.min(contentWidth, Math.ceil(menuX + menuWidth + MODEL_OVERLAY_FLYOUT_RESERVE_X + BROWSER_OVERLAY_GUTTER));
  const bottom = Math.min(contentHeight, Math.ceil(menuY + menuHeight + MODEL_OVERLAY_FLYOUT_RESERVE_Y + BROWSER_OVERLAY_GUTTER));
  return {
    bounds: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
    menuOffset: { x: menuX - x, y: menuY - y },
  };
}

export function showBrowserOverlayRendered(
  contents: WebContents,
  rendered: BrowserOverlayRendered,
): void {
  const entry = liveEntry();
  if (entry === null) return;
  const current = entry.current;
  if (current === null) return;
  if (entry.view.webContents !== contents || current.requestId !== rendered.requestId) return;
  if (current.kind === 'dialog' && current.annotation && current.anchor !== undefined) {
    if (entry.visible) return;
    entry.host.contentView.removeChildView(entry.view);
    entry.host.contentView.addChildView(entry.view);
    entry.visible = true;
    entry.view.setVisible(true);
    if (!current.preserveFocus) entry.view.webContents.focus();
    entry.view.webContents.send(IPC.browserOverlayShown, { requestId: current.requestId } satisfies BrowserOverlayShown);
    return;
  }
  if (current.kind === 'dialog' && current.anchor === undefined) {
    const contentSize = hostContentSize(entry.host, current.viewport);
    entry.host.contentView.removeChildView(entry.view);
    entry.host.contentView.addChildView(entry.view);
    entry.view.setBounds(current.boundary ?? { x: 0, y: 0, width: contentSize[0], height: contentSize[1] });
    entry.visible = true;
    entry.view.setVisible(true);
    if (!current.preserveFocus && entry.host.isFocused()) entry.view.webContents.focus();
    entry.view.webContents.send(IPC.browserOverlayShown, {
      requestId: current.requestId,
    } satisfies BrowserOverlayShown);
    return;
  }
  const wasVisible = entry.visible;
  if (current.kind === 'menu' && current.modelMenu !== undefined) {
    const contentSize = hostContentSize(entry.host);
    const zoom = entry.zoom;
    const modelLayout = browserModelOverlayLayout({
      contentWidth: (contentSize[0] ?? 0) / zoom,
      contentHeight: (contentSize[1] ?? 0) / zoom,
      anchor: current.anchor,
      menuHeight: rendered.height,
    });
    if (!wasVisible) {
      entry.host.contentView.removeChildView(entry.view);
      entry.host.contentView.addChildView(entry.view);
    }
    const { x, y, width, height } = modelLayout.bounds;
    entry.view.setBounds({
      x: Math.floor(x * zoom),
      y: Math.floor(y * zoom),
      width: Math.ceil((x + width) * zoom) - Math.floor(x * zoom),
      height: Math.ceil((y + height) * zoom) - Math.floor(y * zoom),
    });
    entry.visible = true;
    entry.view.setVisible(true);
    if (current.preserveFocus !== true) entry.view.webContents.focus();
    entry.view.webContents.send(IPC.browserOverlayShown, {
      requestId: current.requestId,
      placement: 'top-end',
      menuOffset: modelLayout.menuOffset,
    } satisfies BrowserOverlayShown);
    return;
  }
  const contentSize = hostContentSize(entry.host, current.kind === 'dialog' ? current.viewport : undefined);
  const contentWidth = contentSize[0] ?? 0;
  const contentHeight = contentSize[1] ?? 0;
  const boundary = current.kind === 'dialog' ? current.boundary : undefined;
  const layout = browserOverlayLayout({
    contentWidth: boundary?.width ?? contentWidth / entry.zoom,
    contentHeight: boundary?.height ?? contentHeight / entry.zoom,
    config: current.kind === 'dialog' ? { anchor: { ...current.anchor!, x: current.anchor!.x - (boundary?.x ?? 0), y: current.anchor!.y - (boundary?.y ?? 0) }, placement: 'bottom-start' } : current,
    allowFlip: current.kind !== 'dialog' || !current.annotation,
    cardWidth: rendered.width,
    cardHeight: rendered.height,
  });
  if (!wasVisible || (current.kind === 'menu' ? !current.preserveFocus : !current.annotation)) {
    entry.host.contentView.removeChildView(entry.view);
    entry.host.contentView.addChildView(entry.view);
  }
  const { x, y, width, height } = layout.bounds;
  const zoom = entry.zoom;
  entry.view.setBounds({ x: Math.floor(x * zoom) + (boundary?.x ?? 0), y: Math.floor(y * zoom) + (boundary?.y ?? 0), width: Math.ceil((x + width) * zoom) - Math.floor(x * zoom), height: Math.ceil((y + height) * zoom) - Math.floor(y * zoom) });
  entry.visible = true;
  entry.view.setVisible(true);
  if (current.kind === 'menu' ? current.preserveFocus !== true : !current.preserveFocus && !wasVisible) entry.view.webContents.focus();
  entry.view.webContents.send(IPC.browserOverlayShown, {
    requestId: current.requestId,
    placement: layout.placement ?? 'bottom-end',
  } satisfies BrowserOverlayShown);
}

export function markBrowserOverlayHidden(
  contents: WebContents,
  payload: BrowserOverlayVisibilityRequest,
): void {
  const entry = liveEntry();
  if (entry === null || entry.view.webContents !== contents) return;
  finishHideEntry(entry, payload.requestId);
}

export function activateBrowserOverlayItem(contents: WebContents, request: BrowserOverlayActivateRequest): void {
  const entry = liveEntry();
  if (entry === null) return;
  const current = entry.current;
  if (current === null || entry.view.webContents !== contents || current.requestId !== request.requestId) return;
  const { itemId } = request;
  if (current.kind === 'menu' && current.modelMenu !== undefined) {
    if (request.modelAction === undefined) return;
    liveHost()?.webContents.send(IPC.browserOverlayAction, {
      menuId: current.menuId,
      itemId,
      keepOpen: true,
      modelAction: request.modelAction,
    } satisfies BrowserOverlayAction);
    return;
  }
  if (current.kind === 'dialog') {
    if (itemId !== 'confirm' && itemId !== 'cancel' && itemId !== 'auxiliary') return;
    if (itemId === 'auxiliary' && (!current.auxiliary || current.auxiliary.disabled)) return;
    if (current.loading === true && itemId === 'cancel') return;
    const payload: BrowserOverlayDialogAction = {
      dialogId: current.dialogId,
      action: itemId,
    };
    liveHost()?.webContents.send(IPC.browserOverlayDialogAction, payload);
    return;
  }
  const item = current.items.find(
    (candidate) => candidate.kind === 'item' && candidate.id === itemId,
  );
  const owner = item ?? current.items.find((candidate) => candidate.kind === 'item' && candidate.actions?.some((action) => action.id === itemId));
  if (owner !== undefined && owner.kind === 'item') {
    if (owner.disabled === true) return;
    const menuId = current.menuId;
    const keepOpen = owner.id === itemId ? owner.keepOpen : owner.actions?.find((action) => action.id === itemId)?.keepOpen;
    if (keepOpen === true) {
      liveHost()?.webContents.send(IPC.browserOverlayAction, { menuId, itemId, keepOpen: true } satisfies BrowserOverlayAction);
      return;
    }
    hideEntry(entry, 'action');
    if (entry.visible && !entry.host.isDestroyed() && !entry.host.webContents.isDestroyed() &&
      entry.host.isFocused() && entry.view.webContents.isFocused()) {
      entry.restoreFocusOnHide = false;
      entry.host.webContents.focus();
    }
    const payload: BrowserOverlayAction = { menuId, itemId };
    liveHost()?.webContents.send(IPC.browserOverlayAction, payload);
    return;
  }
  const choice = current.items.find(candidate => candidate.kind === 'choices' && candidate.options.some(option => option.id === itemId));
  if (choice !== undefined) {
    liveHost()?.webContents.send(IPC.browserOverlayAction, { menuId: current.menuId, itemId, keepOpen: true } satisfies BrowserOverlayAction);
    return;
  }
  const notice = current.items.find(candidate => candidate.kind === 'choices' && candidate.notice?.action === itemId);
  if (notice !== undefined) {
    liveHost()?.webContents.send(IPC.browserOverlayAction, { menuId: current.menuId, itemId, keepOpen: true } satisfies BrowserOverlayAction);
    return;
  }
  const zoom = current.items.find(
    (candidate) =>
      candidate.kind === 'zoom' &&
      (candidate.decreaseAction === itemId ||
        candidate.increaseAction === itemId ||
        candidate.resetAction === itemId),
  );
  if (zoom === undefined || zoom.kind !== 'zoom') return;
  if (
    (zoom.decreaseAction === itemId && zoom.decreaseDisabled === true) ||
    (zoom.increaseAction === itemId && zoom.increaseDisabled === true) ||
    (zoom.resetAction === itemId && zoom.resetDisabled === true)
  ) {
    return;
  }
  const menuId = current.menuId;
  const payload: BrowserOverlayAction = { menuId, itemId, keepOpen: true };
  liveHost()?.webContents.send(IPC.browserOverlayAction, payload);
}

export function dismissBrowserOverlay(contents: WebContents, request: BrowserOverlayDismissRequest): void {
  const entry = liveEntry();
  const current = entry?.current;
  if (entry === null || current == null || entry.view.webContents !== contents || current.requestId !== request.requestId) return;
  if (current.kind === 'dialog' && (current.loading === true || current.dismissible === false)) return;
  hideEntry(entry, request.reason);
}

export function submitBrowserOverlayForm(contents: WebContents, action: BrowserOverlayFormAction): void {
  const entry = liveEntry();
  const current = entry?.current;
  if (entry === null || current?.kind !== 'dialog' || entry.view.webContents !== contents || current.requestId !== action.requestId || (current.input === undefined && current.checkbox === undefined) || current.loading === true) return;
  if (action.action === 'auxiliary' && (current.auxiliary === undefined || current.auxiliary.disabled)) return;
  const payload: BrowserOverlayDialogAction = { dialogId: current.dialogId, action: action.action, value: current.input === undefined ? undefined : current.input.readOnly ? current.input.value : action.value, checked: current.checkbox === undefined ? undefined : current.checkbox.disabled || current.input?.readOnly ? current.checkbox.checked : action.checked ?? current.checkbox.checked };
  liveHost()?.webContents.send(IPC.browserOverlayDialogAction, payload);
}

export function destroyBrowserOverlay(): void {
  destroyEntry();
}

export function refreshBrowserAnnotationOverlay(): void {
  const entry = liveEntry();
  const current = entry?.current;
  if (!entry || current?.kind !== 'dialog' || !current.annotation) return;
  const boundary = browserAnnotationViewBounds(browserCaptureBindingId(current.annotation.capture));
  if (JSON.stringify(boundary) !== JSON.stringify(current.boundary)) flushConfig(entry);
}
