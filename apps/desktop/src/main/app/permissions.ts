import type { Session } from 'electron';

const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'local-fonts']);

export function isTrustedPermissionOrigin(pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'app:' && url.hostname === 'renderer') return true;
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  }
  return false;
}

export function installPermissionHandler(session: Session): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const granted =
      ALLOWED_PERMISSIONS.has(permission) &&
      isTrustedPermissionOrigin(webContents.getURL()) &&
      (details.isMainFrame || isTrustedPermissionOrigin(details.requestingUrl));
    callback(granted);
  });
}
