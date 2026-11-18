
import type { TokenInfo } from '@moonshot-ai/kimi-code-oauth/device';

const ME_URL = '/auth/me';
const EXCHANGE_URL = '/auth/exchange';
const LOGOUT_URL = '/auth/logout';

export interface SessionInfo {
  userId: string;
  level: number;
  nickname: string;
  avatar?: string;
  userLevelName: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function probeSession(): Promise<SessionInfo | null> {
  try {
    const res = await fetch(ME_URL, { credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const data = body as Record<string, unknown>;
    const userId = stringField(data, 'user_id');
    if (!userId) return null;
    return {
      userId,
      level: typeof data.level === 'number' && Number.isFinite(data.level) ? data.level : 0,
      nickname: stringField(data, 'nickname') ?? '',
      avatar: stringField(data, 'avatar'),
      userLevelName: stringField(data, 'user_level_name') ?? '',
    };
  } catch {
    return null;
  }
}

export class ExchangeError extends Error {
  constructor(readonly status: number) {
    super(`auth exchange failed: HTTP ${status}`);
    this.name = 'ExchangeError';
  }
}

export async function exchangeSession(token: TokenInfo): Promise<void> {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_in: token.expiresIn,
    }),
  });
  if (res.status !== 204) {
    throw new ExchangeError(res.status);
  }
}

export class LogoutError extends Error {
  constructor(readonly status: number) {
    super(`auth logout failed: HTTP ${status}`);
    this.name = 'LogoutError';
  }
}

export async function logoutSession(): Promise<void> {
  const res = await fetch(LOGOUT_URL, { method: 'POST', credentials: 'same-origin' });
  if (res.status !== 204) throw new LogoutError(res.status);
}
