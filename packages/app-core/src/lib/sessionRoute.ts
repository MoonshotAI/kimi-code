
export type SessionUrlMode = 'push' | 'replace' | 'none';

const SESSION_PATH_PREFIX = '/sessions/';

export const SESSION_LINK_PREFIX = 'kimi-code://sessions/';

export const SESSION_ADMIN_PATH = '/admin/sessions';

export function isSessionAdminLocation(loc: Pick<Location, 'pathname'>): boolean {
  return loc.pathname === SESSION_ADMIN_PATH;
}

export function readSessionIdFromLocation(loc: Pick<Location, 'pathname'>): string | undefined {
  const { pathname } = loc;
  if (!pathname.startsWith(SESSION_PATH_PREFIX)) return undefined;
  const rest = pathname.slice(SESSION_PATH_PREFIX.length);
  if (!rest || rest.includes('/')) return undefined;
  try {
    const id = decodeURIComponent(rest);
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function sessionUrl(sessionId: string | undefined): string {
  return sessionId === undefined || sessionId.length === 0
    ? '/'
    : `${SESSION_PATH_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function sessionLink(sessionId: string): string {
  return `${SESSION_LINK_PREFIX}${encodeURIComponent(sessionId)}`;
}
