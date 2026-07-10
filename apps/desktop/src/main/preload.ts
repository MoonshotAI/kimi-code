import { contextBridge, ipcRenderer } from 'electron';

// Renderer-facing surface of the `window.kimiDesktop` bridge. Keep this a tight
// whitelist: every native capability is exposed as an explicit method. NEVER
// expose `ipcRenderer`, `node`, or `require` — the renderer is sandboxed with
// contextIsolation and must reach the main process only through these methods.
export type DialogOptions = Record<string, unknown>;

export type KimiDesktopApi = {
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  onMenu: (cb: (action: string) => void) => () => void;
  onMenuAction: (cb: (id: string) => void) => () => void;
  onShortcut: (cb: (accel: string) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  showOpenDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  getServerToken: () => Promise<string | undefined>;
};

export const api: KimiDesktopApi = {
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  onMenu: (cb) => {
    const listener = (_event: unknown, action: string) => cb(action);
    ipcRenderer.on('kimi:menu', listener);
    return () => ipcRenderer.removeListener('kimi:menu', listener);
  },
  onMenuAction: (cb) => {
    const listener = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('kimi:menu-action', listener);
    return () => ipcRenderer.removeListener('kimi:menu-action', listener);
  },
  onShortcut: (cb) => {
    const listener = (_event: unknown, accel: string) => cb(accel);
    ipcRenderer.on('kimi:shortcut', listener);
    return () => ipcRenderer.removeListener('kimi:shortcut', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('kimi:open-external', url),
  showOpenDialog: (opts) => ipcRenderer.invoke('kimi:dialog-open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('kimi:dialog-save', opts),
  getServerToken: () => ipcRenderer.invoke('kimi:get-server-token'),
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
