import { fileUrlPath } from '@moonshot-ai/app-core/lib';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client';
import type { ResolveOpenLocalHtmlFile } from '@moonshot-ai/app-core/contracts';
import { readonly, ref, type Ref } from 'vue';
import { createBrowserId, type BrowserId } from '../../shared/browser';
import type { LocalFileBrowserBridge } from './nativeBrowser';

const HTML_PATH = /\.html?$/i;
const ABSOLUTE_PATH = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export interface LocalPagesCapability {
  allowed: Readonly<Ref<boolean>>;
  probe: () => void;
}

export function createLocalPagesCapability(read: () => Promise<boolean>): LocalPagesCapability {
  const allowed = ref(false);
  let pending: Promise<void> | null = null;
  return {
    allowed: readonly(allowed),
    probe: () => {
      pending ??= read().then((value) => { allowed.value = value === true; }).catch(() => {});
    },
  };
}

export type LocalHtmlOpenResult = 'opened' | 'failed' | 'stale';

export interface LocalHtmlOpener {
  available: () => boolean;
  open: (target: string, urlSuffix?: string) => Promise<LocalHtmlOpenResult>;
}

export interface LocalHtmlContext {
  sessionId: string | null;
  workspaceId: string | null;
}

export interface LocalHtmlOpenerOptions {
  bridge: LocalFileBrowserBridge | null;
  enabled: () => boolean;
  context: () => LocalHtmlContext;
  draftPromotion: () => LocalHtmlContext | null;
  interactionVersion: () => number;
  openTab: (browserId: BrowserId) => void;
  sessionDestroyed: (sessionId: string) => boolean;
  addToSession: (sessionId: string, browserId: BrowserId) => void;
  discard: (browserId: BrowserId) => void;
}

export function isLocalHtmlContextCurrent(origin: LocalHtmlContext, current: LocalHtmlContext, promotion: LocalHtmlContext | null): boolean {
  if (origin.sessionId === null && promotion !== null && promotion.sessionId === current.sessionId && promotion.workspaceId === origin.workspaceId) return true;
  return current.sessionId === origin.sessionId && (origin.sessionId !== null || current.workspaceId === origin.workspaceId);
}

export function localHtmlPathTarget(path: string, cwd: string): string | null {
  if (!HTML_PATH.test(path) || path.startsWith('~')) return null;
  if (/^[\\/](?![\\/])/.test(path)) {
    const drive = /^([a-zA-Z]:)[\\/]/.exec(cwd)?.[1] ?? /^(\\\\[^\\/]+\\[^\\/]+)(?=[\\/]|$)/.exec(cwd)?.[1];
    if (drive !== undefined) return `${drive}${path}`;
    if (path.startsWith('/')) return path;
  } else if (ABSOLUTE_PATH.test(path)) {
    return path;
  }
  if (URL_SCHEME.test(path)) return null;
  if (cwd === '') return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const root = trimmed === '' || /^[a-zA-Z]:$/.test(trimmed);
  return `${trimmed}${root ? cwd.charAt(trimmed.length) : '/'}${path}`;
}

export function createLocalHtmlOpener(options: LocalHtmlOpenerOptions): LocalHtmlOpener {
  const available = () => options.bridge !== null && options.enabled();
  const isCurrent = (origin: LocalHtmlContext) => isLocalHtmlContextCurrent(origin, options.context(), options.draftPromotion());
  return {
    available,
    async open(target, urlSuffix = '') {
      const bridge = options.bridge;
      if (bridge === null || !options.enabled()) return 'failed';
      const origin = options.context();
      const versionAtStart = options.interactionVersion();
      const browserId = createBrowserId();
      const destroyed = () => origin.sessionId !== null && options.sessionDestroyed(origin.sessionId);
      try {
        await bridge.browserOpenLocalFile(browserId, target, urlSuffix);
      } catch {
        return !destroyed() && options.interactionVersion() === versionAtStart && isCurrent(origin) ? 'failed' : 'stale';
      }
      if (destroyed()) {
        options.discard(browserId);
      } else if (isCurrent(origin)) {
        if (!options.enabled()) {
          options.discard(browserId);
          return 'failed';
        }
        if (options.interactionVersion() === versionAtStart) options.openTab(browserId);
        else if (origin.sessionId !== null) options.addToSession(origin.sessionId, browserId);
        else options.discard(browserId);
      } else if (origin.sessionId !== null) {
        options.addToSession(origin.sessionId, browserId);
      } else {
        options.discard(browserId);
      }
      return 'opened';
    },
  };
}

export function openFileOrLocalHtml(
  request: FilePreviewRequest,
  opener: LocalHtmlOpener,
  cwd: string,
  preview: (request: FilePreviewRequest) => void,
): void {
  const eligible = request.line === undefined && typeof request.content !== 'string' && request.assumed !== true && opener.available();
  const target = eligible ? localHtmlPathTarget(request.path, cwd) : null;
  if (target === null) {
    preview(request);
    return;
  }
  void opener.open(target, request.urlSuffix).then((result) => {
    if (result === 'failed') preview(request);
  });
}

export function openLocalHtmlFileUrl(
  url: string,
  opener: LocalHtmlOpener,
  preview: (request: FilePreviewRequest) => void,
): void {
  void opener.open(url).then((result) => {
    if (result !== 'failed') return;
    const path = fileUrlPath(url);
    if (path !== null) preview({ path });
  });
}

export function reportLocalHtmlOpenFailure(open: Promise<LocalHtmlOpenResult>, notify: () => void): void {
  void open.then((result) => {
    if (result === 'failed') notify();
  });
}

export function localHtmlLinkHandler(
  opener: LocalHtmlOpener,
  preview: (request: FilePreviewRequest) => void,
  beforeOpen: () => void = () => {},
): ResolveOpenLocalHtmlFile {
  return () => (url) => {
    beforeOpen();
    openLocalHtmlFileUrl(url, opener, preview);
  };
}
