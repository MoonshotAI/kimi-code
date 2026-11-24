import type { WebContents } from 'electron';
import { log, redactUrlForLog } from '../diagnostics/log';
import { showFailureFeedback } from '../app/failure-dialog';

export type LinkAction = 'allow' | 'open-external' | 'deny';

export interface ServerRequestTarget {
  baseUrl: string;
  authorization?: string;
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isServerApiUrl(url: string, serverBaseUrl: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(serverBaseUrl);
  } catch {
    return false;
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  return target.origin === base.origin && target.pathname.startsWith(`${basePath}/api/`);
}

export function decideWindowOpen(url: string): LinkAction {
  if (url === '' || url === 'about:blank') return 'allow';
  if (isHttpUrl(url)) return 'open-external';
  return 'deny';
}

export function decideNavigation(currentUrl: string, targetUrl: string): LinkAction {
  if (/^file:/i.test(targetUrl)) return 'deny';
  if (isHttpUrl(targetUrl) && originOf(targetUrl) !== originOf(currentUrl)) {
    return 'open-external';
  }
  return 'allow';
}

export function reportExternalLinkFailure(url: string, error: unknown): void {
  log.error(`[kimi-desktop] external link open failed: ${redactUrlForLog(url)}`, error);
  showFailureFeedback(
    'external-link',
    { title: '无法打开链接', detail: '系统未能调起浏览器，请复制链接后手动打开', ok: '确定', copyLink: '复制链接' },
    { title: "Couldn't open link", detail: "Couldn't open your browser. Copy the link and open it manually", ok: 'OK', copyLink: 'Copy link' },
    url,
  );
}

function openExternalAndReport(openExternal: (url: string) => Promise<void>, url: string): void {
  try {
    void openExternal(url).catch((error: unknown) => reportExternalLinkFailure(url, error));
  } catch (error) {
    reportExternalLinkFailure(url, error);
  }
}

export function installExternalLinkGuard(
  contents: WebContents,
  openExternal: (url: string) => Promise<void>,
  serverTarget?: () => ServerRequestTarget | null,
): void {
  const downloadFromServer = (url: string): boolean => {
    const target = serverTarget?.() ?? null;
    if (target === null || !isServerApiUrl(url, target.baseUrl)) return false;
    contents.session.downloadURL(
      url,
      target.authorization === undefined ? undefined : { headers: { Authorization: target.authorization } },
    );
    return true;
  };
  contents.setWindowOpenHandler(({ url }) => {
    const action = decideWindowOpen(url);
    if (action === 'open-external') {
      if (!downloadFromServer(url)) openExternalAndReport(openExternal, url);
      return { action: 'deny' as const };
    }
    return action === 'allow' ? { action: 'allow' as const } : { action: 'deny' as const };
  });
  contents.on('will-navigate', (event, url) => {
    const action = decideNavigation(contents.getURL(), url);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'open-external' && !downloadFromServer(url)) openExternalAndReport(openExternal, url);
  });
}
