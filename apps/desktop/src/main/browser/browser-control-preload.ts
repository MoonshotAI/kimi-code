import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserControlSurfaceBridge } from '../../shared/browser-control';
import { browserValidators } from '../../shared/browser-control';

const bridge: BrowserControlSurfaceBridge = {
  ready: () => ipcRenderer.send('kimi:browser-control-ready'),
  takeOver: (browserId, revision) => {
    if (browserValidators.takeover.Check({ browserId, revision })) ipcRenderer.send('kimi:browser-control-takeover', { browserId, revision });
  },
  downloadAction: (action) => {
    if (browserValidators.downloadAction.Check(action)) ipcRenderer.send('kimi:browser-control-download', action);
  },
  onDialogs: (cb) => {
    const listener = (_event: unknown, dialogs: unknown) => { if (browserValidators.dialogs.Check(dialogs)) cb(dialogs); };
    ipcRenderer.on('kimi:browser-control-dialogs', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-dialogs', listener);
  },
  onSurface: (cb) => {
    const listener = (_event: unknown, surface: unknown) => { if (browserValidators.surface.Check(surface)) cb(surface); };
    ipcRenderer.on('kimi:browser-control-surface', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-surface', listener);
  },
  onActivity: (cb) => {
    const listener = (_event: unknown, activity: unknown) => { if (browserValidators.activity.Check(activity)) cb(activity); };
    ipcRenderer.on('kimi:browser-control-activity', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-activity', listener);
  },
  onResizing: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:browser-control-resizing', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-resizing', listener);
  },
  onPointer: (cb) => {
    const listener = (_event: unknown, pointer: unknown) => { if (browserValidators.pointer.Check(pointer)) cb(pointer); };
    ipcRenderer.on('kimi:browser-control-pointer', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-pointer', listener);
  },
};
contextBridge.exposeInMainWorld('kimiBrowserControl', bridge);
