import type { Session } from 'electron';

export interface FileRequestDetails {
  resourceType: string;
  frame?: unknown;
}

const NO_WORKERS = "worker-src 'none'";

export function blocksFileRead(details: FileRequestDetails): boolean {
  if (details.resourceType === 'xhr') return true;
  return details.resourceType === 'script' && details.frame == null;
}

export function withoutFileWorkers(resourceType: string, headers: Record<string, string[]> = {}, extraPrivileges = true): Record<string, string[]> | undefined {
  if (!extraPrivileges) return undefined;
  if (resourceType !== 'mainFrame' && resourceType !== 'subFrame') return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
  return { ...headers, [key]: [...(headers[key] ?? []), NO_WORKERS] };
}

export function installFileReadFallbackGuard(browserSession: Session, extraPrivileges: () => boolean = () => true): void {
  const filter = { urls: ['file://*/*'] };
  browserSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({ cancel: blocksFileRead(details) });
  });
  browserSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = withoutFileWorkers(details.resourceType, details.responseHeaders, extraPrivileges());
    callback(responseHeaders === undefined ? {} : { responseHeaders });
  });
}
