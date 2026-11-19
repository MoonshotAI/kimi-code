import type { InjectionKey } from 'vue';

export interface BrowserLiveView {
  state(sessionId: string): { visible: boolean; tabId: string } | null;
  show(sessionId: string): void;
}

export const BrowserLiveViewKey: InjectionKey<BrowserLiveView> = Symbol('BrowserLiveView');

export interface BrowserFaviconSource {
  refresh(): void;
  favicon(url: string): string | undefined;
}

export const BrowserFaviconSourceKey: InjectionKey<BrowserFaviconSource> = Symbol('BrowserFaviconSource');
