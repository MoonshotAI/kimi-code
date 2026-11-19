import { h, render, type App, type AppContext, type Component, type Plugin } from 'vue';
import type { ToastOptions, ToastPosition } from '@moonshot-ai/app-ui';

export interface ToastEvent {
  type: 'show' | 'dismiss';
  options?: ToastOptions;
  key?: number;
}

type ToastListener = (event: ToastEvent) => void;

let hostComponent: Component | null = null;
let hostAppContext: AppContext | null = null;
let hostMounted = false;
const listeners = new Set<ToastListener>();
const replaceRevisions = new Map<ToastPosition, number>();
let nextReplaceRevision = 0;

export function createKimiToast(host: Component): Plugin {
  return {
    install(app: App) {
      hostComponent = host;
      hostAppContext = app._context;
      mountHost();
    },
  };
}

function mountHost(): void {
  if (hostMounted || hostComponent === null || hostAppContext === null || typeof document === 'undefined') return;
  hostMounted = true;
  const container = document.createElement('div');
  container.dataset.kimiToastHost = '';
  document.body.appendChild(container);
  const vnode = h(hostComponent);
  vnode.appContext = hostAppContext;
  render(vnode, container);
}

export function onToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: ToastEvent): void {
  mountHost();
  for (const listener of listeners) listener(event);
}

export function toastReplaceRevision(position: ToastPosition = 'top-center'): number {
  return replaceRevisions.get(position) ?? 0;
}

export function toast(options: ToastOptions, key?: number): void {
  if ((options.mode ?? 'stack') === 'replace') {
    const position = options.position ?? 'top-center';
    replaceRevisions.set(position, ++nextReplaceRevision);
  }
  emit({ type: 'show', options, key });
}

export function dismissToastByKey(key: number): void {
  emit({ type: 'dismiss', key });
}
