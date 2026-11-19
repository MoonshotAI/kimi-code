import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = {
  loaded: 'kimi:shot-loaded',
  setContext: 'kimi:shot-set-context',
  windowCandidates: 'kimi:shot-window-candidates',
  failed: 'kimi:shot-failed',
  action: 'kimi:shot-action',
  copyColor: 'kimi:shot-copy-color',
  cancel: 'kimi:shot-cancel',
  bandStart: 'kimi:shot-band-start',
  bandEnd: 'kimi:shot-band-end',
  previewEnabled: 'kimi:shot-preview-enabled',
  ready: 'kimi:shot-ready',
  editText: 'kimi:shot-edit-text',
  clearSelection: 'kimi:shot-clear-selection',
  pointerEnter: 'kimi:shot-pointer-enter',
  pointerLeave: 'kimi:shot-pointer-leave',
} as const;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validOutputPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload['captureId'] !== 'string' || payload['captureId'] === '') return false;
  if (payload['action'] !== 'add' && payload['action'] !== 'copy' && payload['action'] !== 'save' && payload['action'] !== 'pin') return false;
  if (typeof payload['displayId'] !== 'string' || payload['displayId'] === '') return false;
  if (!(payload['pngBytes'] instanceof Uint8Array)) return false;
  if (!finite(payload['width']) || !finite(payload['height'])) return false;
  return typeof payload['comment'] === 'string' && payload['comment'].length <= 20_000;
}

function validColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^#[0-9A-F]{6}$/.test(value)) return true;
  const rgba = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)\)$/.exec(value);
  return rgba !== null && rgba.slice(1, 4).every((channel) => Number(channel) <= 255);
}

contextBridge.exposeInMainWorld('shotBridge', {
  platform: process.platform,
  loaded: () => ipcRenderer.send(CHANNELS.loaded),
  perform: async (payload: unknown) => {
    if (!validOutputPayload(payload)) return { status: 'error', reason: 'invalid-payload' };
    return ipcRenderer.invoke(CHANNELS.action, payload);
  },
  copyColor: async (captureId: unknown, color: unknown) => {
    if (typeof captureId !== 'string' || captureId === '' || !validColor(color)) return false;
    return ipcRenderer.invoke(CHANNELS.copyColor, captureId, color);
  },
  cancel: (captureId: string) => ipcRenderer.send(CHANNELS.cancel, captureId),
  bandStart: (captureId: string) => ipcRenderer.send(CHANNELS.bandStart, captureId),
  bandEnd: (captureId: string) => ipcRenderer.send(CHANNELS.bandEnd, captureId),
  pointerEnter: (captureId: string) => ipcRenderer.send(CHANNELS.pointerEnter, captureId),
  ready: (captureId: string) => ipcRenderer.send(CHANNELS.ready, captureId),
  editText: (captureId: string, command: unknown) => {
    if (command === 'selectAll' || command === 'cut' || command === 'copy' || command === 'paste' || command === 'undo' || command === 'redo') {
      ipcRenderer.send(CHANNELS.editText, captureId, command);
    }
  },
  failed: (captureId: string, stage: string) => ipcRenderer.send(CHANNELS.failed, captureId, stage),
  onContext: (cb: (context: unknown) => void) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, context: unknown) => cb(context);
    ipcRenderer.on(CHANNELS.setContext, listener);
    return () => ipcRenderer.removeListener(CHANNELS.setContext, listener);
  },
  onWindowCandidates: (cb: (captureId: string, windows: unknown) => void) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, captureId: string, windows: unknown) => cb(captureId, windows);
    ipcRenderer.on(CHANNELS.windowCandidates, listener);
    return () => ipcRenderer.removeListener(CHANNELS.windowCandidates, listener);
  },
  onClearSelection: (cb: (captureId: string) => void) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, captureId: string) => cb(captureId);
    ipcRenderer.on(CHANNELS.clearSelection, listener);
    return () => ipcRenderer.removeListener(CHANNELS.clearSelection, listener);
  },
  onPreviewEnabled: (cb: (captureId: string) => void) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, captureId: string) => cb(captureId);
    ipcRenderer.on(CHANNELS.previewEnabled, listener);
    return () => ipcRenderer.removeListener(CHANNELS.previewEnabled, listener);
  },
  onPointerLeave: (cb: (captureId: string) => void) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, captureId: string) => cb(captureId);
    ipcRenderer.on(CHANNELS.pointerLeave, listener);
    return () => ipcRenderer.removeListener(CHANNELS.pointerLeave, listener);
  },
});
