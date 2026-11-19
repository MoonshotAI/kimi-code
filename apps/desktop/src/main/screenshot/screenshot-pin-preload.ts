import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = {
  close: 'kimi:shot-pin-close',
  ready: 'kimi:shot-pin-ready',
  resizeEdge: 'kimi:shot-pin-resize-edge',
  resize: 'kimi:shot-pin-resize',
  move: 'kimi:shot-pin-move',
} as const;

contextBridge.exposeInMainWorld('pinBridge', {
  platform: process.platform,
  resizeFromEdge: (edge: string, deltaX: number, deltaY: number) => {
    if (typeof edge === 'string' && typeof deltaX === 'number' && Number.isFinite(deltaX) && typeof deltaY === 'number' && Number.isFinite(deltaY)) {
      ipcRenderer.send(CHANNELS.resizeEdge, edge, deltaX, deltaY);
    }
  },
  ready: () => ipcRenderer.send(CHANNELS.ready, true),
  failed: () => ipcRenderer.send(CHANNELS.ready, false),
  close: () => ipcRenderer.send(CHANNELS.close),
  resize: (scaleDelta: number) => {
    if (typeof scaleDelta === 'number' && Number.isFinite(scaleDelta)) ipcRenderer.send(CHANNELS.resize, scaleDelta);
  },
  move: (deltaX: number, deltaY: number) => {
    if (typeof deltaX === 'number' && Number.isFinite(deltaX) && typeof deltaY === 'number' && Number.isFinite(deltaY)) {
      ipcRenderer.send(CHANNELS.move, deltaX, deltaY);
    }
  },
});
