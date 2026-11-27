import type { MouseInputEvent, View, WebContents } from 'electron';

let overlayView: View | null = null;
let outsidePointerHandler: (() => void) | null = null;
let annotationRefreshHandler: (() => void) | null = null;
const outsidePointerContents = new WeakSet<WebContents>();

export function setBrowserOverlayView(view: View | null): void {
  overlayView = view;
}

export function isBrowserOverlayView(view: View): boolean {
  return overlayView !== null && overlayView === view;
}

export function onBrowserOverlayOutsidePointer(handler: () => void): void {
  outsidePointerHandler = handler;
}

export function onBrowserAnnotationOverlayRefresh(handler: () => void): void {
  annotationRefreshHandler = handler;
}

export function observeBrowserOverlayOutsidePointer(contents: WebContents, isUserSurface: () => boolean = () => true): void {
  if (outsidePointerContents.has(contents)) return;
  outsidePointerContents.add(contents);
  contents.on('before-mouse-event', (_event, mouse: MouseInputEvent) => {
    if (mouse.type !== 'mouseDown' || !isUserSurface()) return;
    outsidePointerHandler?.();
  });
}

export function requestBrowserAnnotationOverlayRefresh(): void {
  annotationRefreshHandler?.();
}
