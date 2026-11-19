import { contextBridge, ipcRenderer } from 'electron';

import { isBrowserOverlayConfig, isBrowserOverlayShown, asBrowserOverlayRendered, asBrowserOverlayVisibilityRequest, asBrowserOverlayFormAction, asBrowserOverlayActivateRequest, asBrowserOverlayDismissRequest } from '../../shared/browser-overlay';
import type {
  BrowserOverlayActivateRequest,
  BrowserOverlayDismissRequest,
  BrowserOverlayConfig,
  BrowserOverlayFormAction,
  BrowserOverlayRendered,
  BrowserOverlayShown,
  BrowserOverlayVisibilityRequest,
} from '../../shared/browser-overlay';

interface BrowserOverlayRendererBridge {
  ready: () => void;
  rendered: (payload: BrowserOverlayRendered) => void;
  hidden: (payload: BrowserOverlayVisibilityRequest) => void;
  activate: (payload: BrowserOverlayActivateRequest) => void;
  submitForm: (payload: BrowserOverlayFormAction) => void;
  dismiss: (payload: BrowserOverlayDismissRequest) => void;
  onConfig: (cb: (config: BrowserOverlayConfig) => void) => () => void;
  onShown: (cb: (payload: BrowserOverlayShown) => void) => () => void;
  onHide: (cb: (payload: BrowserOverlayVisibilityRequest) => void) => () => void;
}

function onValidated<T>(
  channel: string,
  validate: (value: unknown) => value is T,
  cb: (value: T) => void,
): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (validate(payload)) cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: BrowserOverlayRendererBridge = {
  ready: () => ipcRenderer.send('kimi:browser-overlay-ready'),
  rendered: (payload) => {
    const request = asBrowserOverlayRendered(payload);
    if (request !== null) ipcRenderer.send('kimi:browser-overlay-rendered', request);
  },
  hidden: (payload) => {
    const request = asBrowserOverlayVisibilityRequest(payload);
    if (request !== null) ipcRenderer.send('kimi:browser-overlay-hidden', request);
  },
  submitForm: (payload) => {
    const request = asBrowserOverlayFormAction(payload);
    if (request !== null) ipcRenderer.send('kimi:browser-overlay-form-action', request);
  },
  activate: (payload) => {
    const request = asBrowserOverlayActivateRequest(payload);
    if (request !== null) ipcRenderer.send('kimi:browser-overlay-activate', request);
  },
  dismiss: (payload) => {
    const request = asBrowserOverlayDismissRequest(payload);
    if (request !== null) ipcRenderer.send('kimi:browser-overlay-dismiss', request);
  },
  onConfig: (cb) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isBrowserOverlayConfig(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-overlay-config', listener);
    return () => ipcRenderer.removeListener('kimi:browser-overlay-config', listener);
  },
  onShown: (cb) => onValidated('kimi:browser-overlay-shown', isBrowserOverlayShown, cb),
  onHide: (cb) => onValidated('kimi:browser-overlay-hide', (value): value is BrowserOverlayVisibilityRequest => asBrowserOverlayVisibilityRequest(value) !== null, cb),
};

contextBridge.exposeInMainWorld('kimiBrowserOverlay', bridge);
