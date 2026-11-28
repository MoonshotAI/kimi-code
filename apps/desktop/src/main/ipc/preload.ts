import { contextBridge } from 'electron';
import { browserBridge, type BrowserBridge } from './bridge/browserBridge';
import { releaseBridge, type ReleaseBridge } from './bridge/releaseBridge';
import { systemBridge, type SystemBridge } from './bridge/systemBridge';
import { windowBridge, type WindowBridge } from './bridge/windowBridge';

export type KimiDesktopApi = WindowBridge & ReleaseBridge & SystemBridge & BrowserBridge;

export const api: KimiDesktopApi = {
  ...windowBridge,
  ...releaseBridge,
  ...systemBridge,
  ...browserBridge,
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
