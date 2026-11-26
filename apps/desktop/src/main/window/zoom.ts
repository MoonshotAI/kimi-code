import type { Input, WebContents } from 'electron';

import { clampMainWindowZoomLevel, getMainWindowZoomLevel, setMainWindowZoomLevel } from '../app/ui-state';

export type MainWindowZoomAction = 'in' | 'out' | 'reset';

const ZOOM_LEVEL_STEP = 0.5;
const ZOOM_LEVEL_EPSILON = 0.001;
const PINCH_SAVE_DEBOUNCE_MS = 200;

export function zoomActionForInput(input: Input, isMac: boolean): MainWindowZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return null;
  if (input.code === 'Equal' || (input.code === 'NumpadAdd' && !input.shift)) return 'in';
  if (input.shift) return null;
  if (input.code === 'Minus' || input.code === 'NumpadSubtract') return 'out';
  if (input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}

export function adjustMainWindowZoom(contents: WebContents | null | undefined, action: MainWindowZoomAction): void {
  if (contents === null || contents === undefined || contents.isDestroyed()) return;
  const current = contents.getZoomLevel();
  const next = action === 'reset'
    ? 0
    : clampMainWindowZoomLevel(current + (action === 'in' ? ZOOM_LEVEL_STEP : -ZOOM_LEVEL_STEP));
  if (Math.abs(next - current) > ZOOM_LEVEL_EPSILON) contents.setZoomLevel(next);
  setMainWindowZoomLevel(next);
}

export function restoreMainWindowZoom(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  const saved = getMainWindowZoomLevel();
  if (Math.abs(contents.getZoomLevel() - saved) > ZOOM_LEVEL_EPSILON) contents.setZoomLevel(saved);
}

export function attachMainWindowZoom(contents: WebContents, canHandleShortcut: () => boolean): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  contents.on('dom-ready', () => restoreMainWindowZoom(contents));
  contents.on('before-input-event', (event, input) => {
    if (!canHandleShortcut()) return;
    const action = zoomActionForInput(input, process.platform === 'darwin');
    if (action === null) return;
    event.preventDefault();
    adjustMainWindowZoom(contents, action);
  });
  contents.on('zoom-changed', () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (contents.isDestroyed()) return;
      setMainWindowZoomLevel(contents.getZoomLevel());
    }, PINCH_SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  });
  contents.once('destroyed', () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  });
}
